import {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@supacode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as Persistence from "../platform/persistence.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "../state/orchestrationV2TestFixtures.ts";
import * as BackgroundSync from "./backgroundSync.ts";
import {
  ENVIRONMENT_ID,
  credentialStore,
  descriptorResponse,
  lan,
  makeFakeFetch,
  pendingUntilAborted,
  type RecordedRequest,
} from "./backgroundSyncTestFixtures.ts";

const EARLIER = v2Now;
const LATER = DateTime.add(v2Now, { hours: 1 });
const SHELL_SEQUENCE = 40;
const THREAD_SEQUENCE = 41;

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const threadRunning = ThreadId.make("thread-running");
const threadSlow = ThreadId.make("thread-slow");

function row(
  id: ThreadId,
  updatedAt: DateTime.Utc,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    ...v2ThreadShell,
    id,
    lineage: { ...v2ThreadShell.lineage, rootThreadId: id },
    updatedAt,
    ...overrides,
  };
}

function detail(
  id: ThreadId,
  updatedAt: DateTime.Utc,
  snapshotSequence: number,
): OrchestrationV2ThreadDetailSnapshot {
  return {
    snapshotSequence,
    projection: {
      ...v2Projection,
      thread: {
        ...v2Projection.thread,
        id,
        lineage: { ...v2Projection.thread.lineage, rootThreadId: id },
        updatedAt,
      },
      updatedAt,
    },
  };
}

const encodeShell = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot));
const encodeBounded = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot));

const SHELL_ROWS = [
  row(threadA, LATER),
  row(threadB, EARLIER),
  row(threadRunning, LATER, { status: "running" }),
  row(threadSlow, EARLIER),
];

/** The environment as seen over HTTP: a shell at 40 and bounded thread snapshots at 41. */
function environmentServer(
  options: {
    readonly rows?: ReadonlyArray<OrchestrationV2ThreadShell>;
    readonly thread?: (
      threadId: ThreadId,
      signal: AbortSignal | undefined,
    ) => Response | Promise<Response> | undefined;
  } = {},
) {
  return makeFakeFetch((request, signal) => {
    if (request.path.endsWith("/environment")) return descriptorResponse();
    if (request.path === "/api/orchestration/shell") {
      return Response.json(
        encodeShell({
          ...v2ShellSnapshot,
          snapshotSequence: SHELL_SEQUENCE,
          threads: options.rows ?? SHELL_ROWS,
        }),
      );
    }
    const match = /^\/api\/orchestration\/threads\/([^/]+)\/bounded$/.exec(request.path);
    if (match === null) return new Response("Not Found", { status: 404 });
    const threadId = ThreadId.make(decodeURIComponent(match[1]!));
    const custom = options.thread?.(threadId, signal);
    if (custom !== undefined) return custom;
    return Response.json(
      encodeBounded({
        ...detail(threadId, LATER, THREAD_SEQUENCE),
        historyCursor: `cursor-${threadId}`,
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 3,
      }),
    );
  });
}

function makeCache(
  initial: {
    readonly shell?: OrchestrationV2ShellSnapshot;
    readonly threads?: ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>;
  } = {},
  beforeThreadWrite: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void,
) {
  let shell = initial.shell;
  const threads = new Map(
    (initial.threads ?? []).map((snapshot) => [snapshot.projection.thread.id, snapshot] as const),
  );
  const store = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.sync(() => Option.fromNullishOr(shell)),
    saveShell: (_, snapshot) =>
      Effect.sync(() => {
        shell = snapshot;
      }),
    loadThread: (_, threadId) => Effect.sync(() => Option.fromNullishOr(threads.get(threadId))),
    saveThread: (_, snapshot) =>
      beforeThreadWrite(snapshot.projection.thread.id).pipe(
        Effect.andThen(
          Effect.sync(() => {
            threads.set(snapshot.projection.thread.id, snapshot);
          }),
        ),
      ),
    removeThread: (_, threadId) =>
      Effect.sync(() => {
        threads.delete(threadId);
      }),
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  return { store, shell: () => shell, threads };
}

function syncLayer(fetchFn: typeof fetch, cache: Persistence.EnvironmentCacheStore["Service"]) {
  return BackgroundSync.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerRemoteHttpClient(fetchFn),
        Layer.succeed(Persistence.EnvironmentCacheStore, cache),
        Layer.succeed(
          Persistence.ConnectionTargetStore,
          Persistence.ConnectionTargetStore.of({
            list: Effect.succeed([lan.target]),
            listDisabled: Effect.succeed([]),
          }),
        ),
        Layer.succeed(
          ConnectionProfileStore.ConnectionProfileStore,
          ConnectionProfileStore.make({
            get: () => Effect.succeed(lan.profile),
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
        ),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
      ),
    ),
  );
}

const threadRequests = (requests: ReadonlyArray<RecordedRequest>) =>
  requests.flatMap((request) =>
    request.path.startsWith("/api/orchestration/threads/") ? [request.path.split("/")[4]] : [],
  );

describe("BackgroundSync", () => {
  it.effect("stores the shell and the stale recent threads, each with its own sequence", () => {
    const server = environmentServer();
    const cache = makeCache({ threads: [detail(threadB, EARLIER, 30)] });
    return Effect.gen(function* () {
      const sync = yield* BackgroundSync.BackgroundSync;
      const report = yield* sync.run({ budgetMs: 25_000 });

      expect(report.outcome).toBe("completed");
      expect(report.environments).toEqual([
        {
          environmentId: ENVIRONMENT_ID,
          status: "synced",
          route: { id: "lan", kind: "lan" },
          shell: { _tag: "saved", sequence: SHELL_SEQUENCE, previousSequence: null },
          threads: [
            {
              threadId: threadA,
              result: { _tag: "saved", sequence: THREAD_SEQUENCE, previousSequence: null },
            },
            {
              threadId: threadSlow,
              result: { _tag: "saved", sequence: THREAD_SEQUENCE, previousSequence: null },
            },
          ],
          error: null,
        },
      ]);
      expect(threadRequests(server.requests)).toEqual([threadA, threadSlow]);
      expect(cache.shell()?.snapshotSequence).toBe(SHELL_SEQUENCE);
      expect(cache.threads.get(threadA)).toMatchObject({
        snapshotSequence: THREAD_SEQUENCE,
        historyCursor: `cursor-${threadA}`,
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 3,
      });
      expect(cache.threads.get(threadB)?.snapshotSequence).toBe(30);
      expect(cache.threads.has(threadRunning)).toBe(false);
      expect(server.requests.every((request) => request.method === "GET")).toBe(true);
      expect(server.requests.some((request) => request.path.includes("websocket-ticket"))).toBe(
        false,
      );
    }).pipe(Effect.provide(syncLayer(server.fetchFn, cache.store)));
  });

  it.effect("keeps newer cached snapshots instead of rolling them back", () => {
    const server = environmentServer({ rows: [row(threadA, LATER)] });
    const cachedShell = { ...v2ShellSnapshot, snapshotSequence: 50 };
    const cache = makeCache({
      shell: cachedShell,
      threads: [detail(threadA, EARLIER, 45), detail(threadB, LATER, THREAD_SEQUENCE)],
    });
    return Effect.gen(function* () {
      const sync = yield* BackgroundSync.BackgroundSync;
      const report = yield* sync.run({
        budgetMs: 25_000,
        priorityThreads: [{ environmentId: ENVIRONMENT_ID, threadId: threadB }],
      });

      const [environment] = report.environments;
      expect(environment?.shell).toEqual({
        _tag: "stale",
        sequence: SHELL_SEQUENCE,
        cachedSequence: 50,
      });
      expect(environment?.threads).toEqual([
        { threadId: threadB, result: { _tag: "unchanged", sequence: THREAD_SEQUENCE } },
        {
          threadId: threadA,
          result: { _tag: "stale", sequence: THREAD_SEQUENCE, cachedSequence: 45 },
        },
      ]);
      expect(cache.shell()).toBe(cachedShell);
      expect(cache.threads.get(threadA)?.snapshotSequence).toBe(45);
    }).pipe(Effect.provide(syncLayer(server.fetchFn, cache.store)));
  });

  it.effect("stops at the deadline, keeps finished writes, and aborts open requests", () => {
    const { promise: slowRequested, resolve: requestSlow } = Promise.withResolvers<void>();
    const server = environmentServer({
      rows: [row(threadA, LATER), row(threadSlow, EARLIER)],
      thread: (threadId, signal) => {
        if (threadId !== threadSlow) return undefined;
        requestSlow();
        return pendingUntilAborted(signal);
      },
    });
    return Effect.gen(function* () {
      const saved = yield* Deferred.make<void>();
      const cache = makeCache({}, (threadId) =>
        threadId === threadA ? Deferred.succeed(saved, undefined).pipe(Effect.asVoid) : Effect.void,
      );
      const sync = yield* BackgroundSync.BackgroundSync.pipe(
        Effect.provide(syncLayer(server.fetchFn, cache.store)),
      );
      const fiber = yield* Effect.forkChild(sync.run({ budgetMs: 3_000 }));
      yield* Effect.promise(() => slowRequested);
      yield* Deferred.await(saved);
      yield* TestClock.adjust("3 seconds");
      const report = yield* Fiber.join(fiber);

      expect(report.outcome).toBe("deadline");
      expect(report.environments[0]?.status).toBe("stopped");
      expect(report.environments[0]?.threads).toEqual([
        {
          threadId: threadA,
          result: { _tag: "saved", sequence: THREAD_SEQUENCE, previousSequence: null },
        },
        { threadId: threadSlow, result: { _tag: "not-reached" } },
      ]);
      expect(cache.threads.get(threadA)?.snapshotSequence).toBe(THREAD_SEQUENCE);
      expect(cache.threads.has(threadSlow)).toBe(false);
      expect(server.requests.find((request) => request.path.includes(threadSlow))?.aborted).toBe(
        true,
      );
    });
  });

  it.effect("finishes an in-flight write before honoring a cancelled task", () => {
    const server = environmentServer({ rows: [row(threadA, LATER)] });
    const controller = new AbortController();
    return Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cache = makeCache({}, () =>
        Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const sync = yield* BackgroundSync.BackgroundSync.pipe(
        Effect.provide(syncLayer(server.fetchFn, cache.store)),
      );
      const fiber = yield* Effect.forkChild(
        sync.run({ budgetMs: 25_000, signal: controller.signal }),
      );
      yield* Deferred.await(writing);
      controller.abort();
      yield* Effect.yieldNow;
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(cache.threads.has(threadA)).toBe(false);

      yield* Deferred.succeed(release, undefined);
      const report = yield* Fiber.join(fiber);

      expect(report.outcome).toBe("cancelled");
      expect(report.environments[0]?.threads).toEqual([
        {
          threadId: threadA,
          result: { _tag: "saved", sequence: THREAD_SEQUENCE, previousSequence: null },
        },
      ]);
      expect(cache.threads.get(threadA)?.snapshotSequence).toBe(THREAD_SEQUENCE);
    });
  });

  it.effect("reports an environment it cannot reach without failing the run", () => {
    const server = makeFakeFetch(() => new Response("Bad Gateway", { status: 502 }));
    const cache = makeCache();
    return Effect.gen(function* () {
      const sync = yield* BackgroundSync.BackgroundSync;
      const report = yield* sync.run({ budgetMs: 25_000 });

      expect(report.outcome).toBe("completed");
      expect(report.environments).toMatchObject([
        { status: "unreachable", route: null, shell: null, threads: [] },
      ]);
      expect(cache.shell()).toBeUndefined();
      expect(server.requests.some((request) => request.authorization !== null)).toBe(false);
    }).pipe(Effect.provide(syncLayer(server.fetchFn, cache.store)));
  });
});
