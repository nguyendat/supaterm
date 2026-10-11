import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { EnvironmentId, ThreadId, ORCHESTRATION_PROTOCOL_VERSION } from "@supacode/contracts";
import { vi } from "vite-plus/test";

const { openDatabaseAsync, getItemAsync } = vi.hoisted(() => ({
  openDatabaseAsync: vi.fn(),
  getItemAsync: vi.fn(),
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));
vi.mock("expo-secure-store", () => ({
  getItemAsync,
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import * as MobileDatabase from "../persistence/mobile-database";
import { mobileBackgroundSyncOnce, runMobileBackgroundSyncOnce } from "./background-sync";

const environmentId = EnvironmentId.make("sync-test");
const payload = (sequence: number, cursor: string) =>
  JSON.stringify({
    snapshot: { snapshotSequence: sequence, historyCursor: cursor, projection: { title: cursor } },
  });

function sqliteAdapter(database: NodeSqlite.DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      database.exec(sql);
    },
    getFirstAsync: async (sql: string, ...params: Array<string | number>) =>
      database.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string, ...params: Array<string | number>) =>
      database.prepare(sql).all(...params),
    runAsync: async (sql: string, ...params: Array<string | number>) =>
      database.prepare(sql).run(...params),
    withExclusiveTransactionAsync: async (
      body: (transaction: { execAsync: (sql: string) => Promise<void> }) => Promise<void>,
    ) => {
      await body(sqliteAdapter(database));
    },
    closeAsync: vi.fn(async () => {
      database.close();
    }),
  };
}

const acquireDatabase = Effect.gen(function* () {
  return Context.get(
    yield* Layer.build(MobileDatabase.isolatedLayer),
    MobileDatabase.MobileDatabase,
  );
});

const makeSqlite = Effect.fnUntraced(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "supacode-sync-sqlite-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  const path = NodePath.join(directory, "client.db");
  const adapters: ReturnType<typeof sqliteAdapter>[] = [];
  openDatabaseAsync.mockImplementation(async () => {
    const database = new NodeSqlite.DatabaseSync(path);
    database.exec("PRAGMA user_version = 1");
    const adapter = sqliteAdapter(database);
    adapters.push(adapter);
    return adapter;
  });
  return { adapters, path };
});

describe("mobile background sync persistence", () => {
  it.effect(
    "rejects a delayed stale write across database connections and persists cursor and snapshot atomically",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeSqlite();
          const first = yield* acquireDatabase;
          const second = yield* acquireDatabase;
          const release = yield* Deferred.make<void>();
          const stale = yield* Deferred.await(release).pipe(
            Effect.andThen(
              first.saveCacheIfNewer(
                environmentId,
                "background-thread",
                "thread-1",
                1,
                payload(10, "old"),
              ),
            ),
            Effect.forkChild,
          );
          expect(
            yield* second.saveCacheIfNewer(
              environmentId,
              "background-thread",
              "thread-1",
              1,
              payload(11, "new"),
            ),
          ).toBe(true);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(stale)).toBe(false);
          expect(
            yield* first.saveCacheIfNewer(
              environmentId,
              "background-thread",
              "thread-1",
              1,
              payload(11, "equal"),
            ),
          ).toBe(false);
          expect(
            JSON.parse(
              Option.getOrThrow(
                yield* first.loadCache(environmentId, "background-thread", "thread-1"),
              ),
            ),
          ).toEqual(JSON.parse(payload(11, "new")));
        }),
      ),
  );

  it.effect(
    "separates background snapshots from foreground cache and clears both with the environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeSqlite();
          const database = yield* acquireDatabase;
          yield* database.saveCache(environmentId, "thread", "thread-1", 3, "foreground");
          yield* database.saveCacheIfNewer(
            environmentId,
            "background-thread",
            "thread-1",
            1,
            payload(50, "background"),
          );
          yield* database.saveCacheIfNewer(
            environmentId,
            "background-shell",
            "snapshot",
            1,
            payload(2, "shell"),
          );
          expect(
            Option.getOrThrow(yield* database.loadCache(environmentId, "thread", "thread-1")),
          ).toBe("foreground");
          expect((yield* database.inspectCaches).map((row) => row.kind).sort()).toEqual([
            "background-shell",
            "background-thread",
            "thread",
          ]);
          yield* database.clearEnvironmentCache(environmentId);
          expect(yield* database.inspectCaches).toEqual([]);
        }),
      ),
  );

  it.effect("waits for a started atomic write to settle when cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapters } = yield* makeSqlite();
        const started = yield* Deferred.make<void>();
        let finish: (() => void) | undefined;
        const database = yield* acquireDatabase;
        const nativeRun = adapters[0]!.runAsync;
        adapters[0]!.runAsync = (sql, ...params) =>
          new Promise((resolve, reject) => {
            finish = () => {
              void nativeRun(sql, ...params).then(resolve, reject);
            };
            Deferred.doneUnsafe(started, Effect.void);
          });
        const write = yield* database
          .saveCacheIfNewer(
            environmentId,
            "background-thread",
            "thread-1",
            1,
            payload(1, "complete"),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const cancelled = yield* Fiber.interrupt(write).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(cancelled.pollUnsafe()).toBeUndefined();
        finish!();
        yield* Fiber.join(cancelled);
        expect(
          Option.getOrThrow(
            yield* database.loadCache(environmentId, "background-thread", "thread-1"),
          ),
        ).toBe(payload(1, "complete"));
      }),
    ),
  );
});

const catalog = JSON.stringify({
  schemaVersion: 1,
  targets: [
    { _tag: "BearerConnectionTarget", environmentId, connectionId: "saved", label: "Host" },
  ],
  profiles: [
    {
      _tag: "BearerConnectionProfile",
      environmentId,
      connectionId: "saved",
      label: "Host",
      httpBaseUrl: "https://sync.example.test/",
      wsBaseUrl: "wss://sync.example.test/",
    },
  ],
  credentials: [
    {
      connectionId: "saved",
      credential: { _tag: "BearerConnectionCredential", token: "read-token" },
    },
  ],
  disabledEnvironmentIds: [],
});
const shell = {
  schemaVersion: 1,
  snapshotSequence: 8,
  projects: [],
  threads: [],
  archivedThreads: [],
};

function mobileFetch(request: RequestInfo | URL) {
  const url = new URL(request instanceof Request ? request.url : String(request));
  return url.pathname === "/.well-known/supacode/environment"
    ? Response.json({
        environmentId,
        label: "Host",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "test",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      })
    : Response.json(shell);
}

describe("mobile headless entry point", () => {
  it.effect("applies the deadline during credential loading and closes acquired storage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapters } = yield* makeSqlite();
        const started = yield* Deferred.make<void>();
        getItemAsync.mockImplementation(
          () =>
            new Promise(() => {
              Deferred.doneUnsafe(started, Effect.void);
            }),
        );
        const sync = yield* mobileBackgroundSyncOnce({ environmentId, deadlineMs: 1_000 }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust(1_000);
        expect(yield* Fiber.join(sync)).toEqual({
          environmentId,
          status: "deadline-exceeded",
          routeId: null,
          shell: null,
          threads: [],
        });
        expect(adapters[0]!.closeAsync).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect(
    "preserves committed progress when the overall mobile deadline aborts a thread fetch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { adapters } = yield* makeSqlite();
          const started = yield* Deferred.make<void>();
          let aborted = false;
          getItemAsync.mockResolvedValue(catalog);
          const originalFetch = globalThis.fetch;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              globalThis.fetch = (request, init) => {
                if (!String(request).includes("/bounded"))
                  return Promise.resolve(mobileFetch(request));
                return new Promise((_resolve, reject) => {
                  Deferred.doneUnsafe(started, Effect.void);
                  init!.signal!.addEventListener(
                    "abort",
                    () => {
                      aborted = true;
                      reject(new Error("Aborted"));
                    },
                    { once: true },
                  );
                });
              };
            }),
            () =>
              Effect.sync(() => {
                globalThis.fetch = originalFetch;
              }),
          );
          const sync = yield* mobileBackgroundSyncOnce({
            environmentId,
            threadIds: [ThreadId.make("thread-1")],
            deadlineMs: 1_000,
          }).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust(1_000);
          expect(yield* Fiber.join(sync)).toEqual({
            environmentId,
            status: "deadline-exceeded",
            routeId: "saved",
            shell: { sequence: 8, stored: true },
            threads: [],
          });
          expect(aborted).toBe(true);
          expect(adapters[0]!.closeAsync).toHaveBeenCalledOnce();
        }),
      ),
  );
  it.effect("runs without a foreground runtime and closes only its own database connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapters, path } = yield* makeSqlite();
        getItemAsync.mockResolvedValue(catalog);
        const originalFetch = globalThis.fetch;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            globalThis.fetch = vi.fn(async (request) => mobileFetch(request));
          }),
          () =>
            Effect.sync(() => {
              globalThis.fetch = originalFetch;
            }),
        );
        const result = yield* Effect.promise(() =>
          runMobileBackgroundSyncOnce({ environmentId, maxThreads: 0 }),
        );
        expect(result).toMatchObject({ status: "completed", shell: { sequence: 8, stored: true } });
        expect(openDatabaseAsync).toHaveBeenLastCalledWith("supacode-client.db", {
          useNewConnection: true,
        });
        expect(adapters[0]!.closeAsync).toHaveBeenCalledOnce();
        const inspect = new NodeSqlite.DatabaseSync(path);
        try {
          expect(
            inspect
              .prepare("SELECT payload FROM client_cache WHERE kind = 'background-shell'")
              .get(),
          ).toMatchObject({ payload: expect.stringContaining('"snapshotSequence":8') });
        } finally {
          inspect.close();
        }
      }),
    ),
  );

  it.effect("aborting the native caller aborts fetch and closes the database", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapters } = yield* makeSqlite();
        const started = yield* Deferred.make<void>();
        let aborted = false;
        getItemAsync.mockResolvedValue(catalog);
        const originalFetch = globalThis.fetch;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            globalThis.fetch = (_request, init) =>
              new Promise((_resolve, reject) => {
                Deferred.doneUnsafe(started, Effect.void);
                init!.signal!.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(new Error("Aborted"));
                  },
                  { once: true },
                );
              });
          }),
          () =>
            Effect.sync(() => {
              globalThis.fetch = originalFetch;
            }),
        );
        const controller = new AbortController();
        const sync = yield* Effect.tryPromise(() =>
          runMobileBackgroundSyncOnce({ environmentId, signal: controller.signal }),
        ).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        controller.abort();
        expect((yield* Fiber.join(sync))._tag).toBe("Failure");
        expect(aborted).toBe(true);
        expect(adapters[0]!.closeAsync).toHaveBeenCalledOnce();
      }),
    ),
  );
});
