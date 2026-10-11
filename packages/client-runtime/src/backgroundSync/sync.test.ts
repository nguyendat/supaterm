import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
} from "@supacode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import { ConnectionCredentialStore } from "../connection/credentialStore.ts";
import * as Store from "./store.ts";
import { syncEnvironmentOnce, type BackgroundSyncInput } from "./sync.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");
const NOW = DateTime.makeUnsafe("2026-07-29T12:00:00.000Z");
const SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 3,
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    },
  ],
  threads: [
    {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: {
        instanceId: PROVIDER_INSTANCE_ID,
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: NOW,
      activityRunStartedAt: NOW,
      activityRunStatus: "running",
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: NOW,
      unsettledAt: NOW,
      lastVisitedAt: null,
      titleRegeneration: {
        requestId: CommandId.make("title-regeneration-1"),
        startedAt: NOW,
      },
      deletedAt: null,
    },
  ],
  archivedThreads: [],
};
const THREAD_SNAPSHOT: OrchestrationV2ThreadDetailSnapshot = {
  snapshotSequence: 4,
  projection: {
    thread: {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: {
        instanceId: PROVIDER_INSTANCE_ID,
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: NOW,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  },
};
const bounded = {
  ...THREAD_SNAPSHOT,
  historyCursor: "older-turns",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 4,
  payloadBudgetExceeded: false,
} satisfies OrchestrationV2ThreadBoundedSnapshot;
const decodeShell = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot));
const encodeShell = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot));
const encodeThread = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot));

function route(connectionId: string, httpBaseUrl: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      connectionId,
      label: connectionId,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId: ENVIRONMENT_ID,
        connectionId,
        label: connectionId,
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace("http", "ws"),
      }),
    ),
  };
}
const lan = route("lan", "http://192.168.1.20:4389/");
const tailnet = route("tailnet", "https://host.test.ts.net/");
const publicRoute = route("public", "https://public.example.test/");
const entry: ConnectionCatalogEntry = { ...lan, enabled: true, alternateRoutes: [tailnet] };
const keyId = (key: Store.SnapshotSyncKey) => JSON.stringify(key);
const makePersistence = Effect.gen(function* () {
  const rows = yield* Ref.make(new Map<string, { sequence: number; payload: string }>());
  const persistence = Store.SnapshotSyncPersistence.of({
    read: (key) =>
      Ref.get(rows).pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows.get(keyId(key))?.payload)),
      ),
    writeIfNewer: (key, sequence, payload) =>
      Ref.modify(rows, (rows) => {
        const current = rows.get(keyId(key));
        if (current !== undefined && current.sequence >= sequence) return [false, rows];
        const next = new Map(rows);
        next.set(keyId(key), { sequence, payload });
        return [true, next];
      }),
  });
  const store = yield* Store.make.pipe(
    Effect.provideService(Store.SnapshotSyncPersistence, persistence),
  );
  return { rows, persistence, store };
});

function responseFor(request: HttpClientRequest.HttpClientRequest) {
  const url = new URL(request.url);
  if (url.pathname === "/.well-known/supacode/environment")
    return Response.json({
      environmentId: ENVIRONMENT_ID,
      label: "Host",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "test",
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      capabilities: { repositoryIdentity: true },
    });
  if (url.pathname === "/api/orchestration/shell")
    return Response.json(encodeShell(SHELL_SNAPSHOT));
  if (url.pathname === `/api/orchestration/threads/${THREAD_ID}/bounded`)
    return Response.json(encodeThread(bounded));
  return new Response("Unexpected endpoint", { status: 500 });
}

const makeHarness = Effect.fnUntraced(function* (
  respond: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response> = (request) =>
    Effect.succeed(responseFor(request)),
) {
  const persistence = yield* makePersistence;
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, yield* respond(request));
    }),
  );
  const credentials = ConnectionCredentialStore.of({
    get: () => Effect.succeedSome(new BearerConnectionCredential({ token: "read-token" })),
    put: () => Effect.die("Background sync must not update credentials"),
    remove: () => Effect.die("Background sync must not remove credentials"),
  });
  const run = (input: Partial<BackgroundSyncInput> = {}) =>
    syncEnvironmentOnce({ entry, ...input }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(ConnectionCredentialStore, credentials),
      Effect.provideService(Store.SnapshotSyncStore, persistence.store),
    );
  return { ...persistence, requests, run };
});

describe("headless snapshot synchronization", () => {
  it.effect(
    "persists shell and bounded history with independent sequence positions using only authenticated reads",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.run({ threadIds: [THREAD_ID, THREAD_ID], maxThreads: 1 });
        expect(result).toEqual({
          environmentId: ENVIRONMENT_ID,
          status: "completed",
          routeId: "lan",
          shell: { sequence: 3, stored: true },
          threads: [
            {
              threadId: THREAD_ID,
              status: "synced",
              sequence: 4,
              stored: true,
              payloadBudgetExceeded: false,
            },
          ],
        });
        expect(Option.getOrThrow(yield* harness.store.loadShell(ENVIRONMENT_ID))).toEqual(
          decodeShell(encodeShell(SHELL_SNAPSHOT)),
        );
        expect(
          Option.getOrThrow(yield* harness.store.loadThread(ENVIRONMENT_ID, THREAD_ID)),
        ).toEqual(bounded);
        expect(harness.requests.every((request) => request.method === "GET")).toBe(true);
        const snapshots = harness.requests.filter((request) => request.url.includes("/api/"));
        expect(snapshots.map((request) => request.headers.authorization)).toEqual([
          "Bearer read-token",
          "Bearer read-token",
        ]);
        expect(
          harness.requests.every(
            (request) => !request.url.includes("websocket-ticket") && !request.url.includes("/ws"),
          ),
        ).toBe(true);
        expect(snapshots[1]!.urlParams).toContainEqual(["compactTurnItems", "1"]);
      }),
  );
  it.effect("prefers a reachable LAN alternate over the saved public primary", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.run({
        entry: { ...publicRoute, enabled: true, alternateRoutes: [lan] },
        maxThreads: 0,
      });
      expect(result.routeId).toBe("lan");
      expect(
        harness.requests
          .filter((request) => request.url.includes("/api/"))
          .every((request) => new URL(request.url).hostname === "192.168.1.20"),
      ).toBe(true);
    }),
  );
  it.effect("falls back when LAN reaches another environment without sending it a credential", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((request) =>
        Effect.succeed(
          new URL(request.url).hostname === "192.168.1.20"
            ? Response.json({
                environmentId: "other-host",
                label: "Other",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "test",
                capabilities: { repositoryIdentity: true },
              })
            : responseFor(request),
        ),
      );
      expect((yield* harness.run()).routeId).toBe("tailnet");
      expect(
        harness.requests
          .filter((request) => new URL(request.url).hostname === "192.168.1.20")
          .every((request) => request.headers.authorization === undefined),
      ).toBe(true);
    }),
  );
  it.effect("falls back when a reachable route rejects authenticated snapshots", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((request) =>
        Effect.succeed(
          new URL(request.url).hostname === "192.168.1.20" && request.url.includes("/api/")
            ? new Response("Unavailable", { status: 503 })
            : responseFor(request),
        ),
      );
      expect((yield* harness.run()).routeId).toBe("tailnet");
    }),
  );
  it.effect("cancels a stalled route attempt before falling back within the overall deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let stopped = false;
      const harness = yield* makeHarness((request) => {
        if (new URL(request.url).hostname !== "192.168.1.20" || !request.url.includes("/api/"))
          return Effect.succeed(responseFor(request));
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              stopped = true;
            }),
          ),
        );
      });
      const fiber = yield* harness.run({ deadlineMs: 10_000 }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(3_000);
      expect((yield* Fiber.join(fiber)).routeId).toBe("tailnet");
      expect(stopped).toBe(true);
    }),
  );
  it.effect(
    "returns committed partial progress on deadline and interrupts the outstanding request",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let stopped = false;
        const harness = yield* makeHarness((request) =>
          request.url.includes("/bounded")
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    stopped = true;
                  }),
                ),
              )
            : Effect.succeed(responseFor(request)),
        );
        const fiber = yield* harness.run({ deadlineMs: 1_000 }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust(1_000);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          status: "deadline-exceeded",
          shell: { sequence: 3, stored: true },
          threads: [],
        });
        expect(stopped).toBe(true);
        expect(Option.isNone(yield* harness.store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toBe(
          true,
        );
      }),
  );
  it.effect("external interruption cancels all probes without persisting", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let active = 0;
      const harness = yield* makeHarness(() =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            active += 1;
          }),
          () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          () =>
            Effect.sync(() => {
              active -= 1;
            }),
        ),
      );
      const fiber = yield* harness.run().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(active).toBe(0);
      expect((yield* Ref.get(harness.rows)).size).toBe(0);
    }),
  );
  it.effect("reports selected thread failure without advancing its cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((request) =>
        Effect.succeed(
          request.url.includes("/bounded")
            ? new Response("Missing", { status: 404 })
            : responseFor(request),
        ),
      );
      const result = yield* harness.run();
      expect(result.status).toBe("partial");
      expect(result.threads).toEqual([
        {
          threadId: THREAD_ID,
          status: "failed",
          reason: "RemoteEnvironmentAuthUndeclaredStatusError",
        },
      ]);
      expect(Option.isNone(yield* harness.store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toBe(true);
    }),
  );
  it.effect("honors disabled environments and shell-only selection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect((yield* harness.run({ entry: { ...entry, enabled: false } })).status).toBe("disabled");
      expect(harness.requests).toEqual([]);
      expect((yield* harness.run({ maxThreads: 0 })).threads).toEqual([]);
      expect(harness.requests.some((request) => request.url.includes("/bounded"))).toBe(false);
    }),
  );
  it.effect("validates resource limits before making requests", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* Effect.result(harness.run({ maxThreads: 21 }))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BackgroundSyncInputError" },
      });
      expect(yield* Effect.result(harness.run({ deadlineMs: 0 }))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BackgroundSyncInputError" },
      });
      expect(harness.requests).toEqual([]);
    }),
  );

  it.effect("defaults to the newest thread while bounding the selected set", () =>
    Effect.gen(function* () {
      const newerId = ThreadId.make("newer-thread");
      const newer = {
        ...SHELL_SNAPSHOT.threads[0]!,
        id: newerId,
        updatedAt: DateTime.makeUnsafe("2026-07-30T12:00:00Z"),
      };
      const harness = yield* makeHarness((request) => {
        if (request.url.includes("/api/orchestration/shell"))
          return Effect.succeed(
            Response.json(
              encodeShell({ ...SHELL_SNAPSHOT, threads: [...SHELL_SNAPSHOT.threads, newer] }),
            ),
          );
        if (request.url.includes(`/threads/${newerId}/bounded`))
          return Effect.succeed(
            Response.json(
              encodeThread({
                ...bounded,
                projection: {
                  ...bounded.projection,
                  thread: { ...bounded.projection.thread, id: newerId },
                },
              }),
            ),
          );
        return Effect.succeed(responseFor(request));
      });
      const result = yield* harness.run({ maxThreads: 1 });
      expect(result.threads.map((thread) => thread.threadId)).toEqual([newerId]);
      expect(harness.requests.filter((request) => request.url.includes("/bounded"))).toHaveLength(
        1,
      );
    }),
  );
  it.effect("reports snapshots already persisted without replacing their cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run();
      const result = yield* harness.run();
      expect(result.shell).toEqual({ sequence: 3, stored: false });
      expect(result.threads).toMatchObject([{ threadId: THREAD_ID, sequence: 4, stored: false }]);
      expect(
        Option.getOrThrow(yield* harness.store.loadThread(ENVIRONMENT_ID, THREAD_ID)).historyCursor,
      ).toBe("older-turns");
    }),
  );
  it.effect("rejects a thread response for a different thread before writing it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness((request) =>
        request.url.includes("/bounded")
          ? Effect.succeed(
              Response.json(
                encodeThread({
                  ...bounded,
                  projection: {
                    ...bounded.projection,
                    thread: { ...bounded.projection.thread, id: ThreadId.make("wrong-thread") },
                  },
                }),
              ),
            )
          : Effect.succeed(responseFor(request)),
      );
      expect(yield* Effect.result(harness.run())).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
      });
      expect(Option.isNone(yield* harness.store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toBe(true);
    }),
  );
  it.effect("does not start a tunnel for relay-only environments", () =>
    Effect.gen(function* () {
      const relay = route(
        "relay",
        `https://${"11".repeat(16)}.${"22".repeat(16)}.relay.supacode.invalid/`,
      );
      const harness = yield* makeHarness();
      expect(
        yield* Effect.result(harness.run({ entry: { ...relay, enabled: true } })),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "unsupported" },
      });
      expect(harness.requests).toEqual([]);
    }),
  );
});

describe("snapshot sync persistence boundary", () => {
  it.effect("rejects stale and equal snapshot writes together with their history cursors", () =>
    Effect.gen(function* () {
      const { store } = yield* makePersistence;
      expect(
        yield* store.saveThread(ENVIRONMENT_ID, {
          ...bounded,
          snapshotSequence: 12,
          historyCursor: "new-cursor",
        }),
      ).toBe(true);
      expect(
        yield* store.saveThread(ENVIRONMENT_ID, {
          ...bounded,
          snapshotSequence: 11,
          historyCursor: "old-cursor",
        }),
      ).toBe(false);
      expect(
        yield* store.saveThread(ENVIRONMENT_ID, {
          ...bounded,
          snapshotSequence: 12,
          historyCursor: "equal-cursor",
        }),
      ).toBe(false);
      expect(Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toMatchObject({
        snapshotSequence: 12,
        historyCursor: "new-cursor",
      });
    }),
  );
  it.effect("keeps environment, shell and thread sequence positions separate", () =>
    Effect.gen(function* () {
      const { store } = yield* makePersistence;
      const other = EnvironmentId.make("other-environment");
      yield* store.saveShell(ENVIRONMENT_ID, { ...SHELL_SNAPSHOT, snapshotSequence: 100 });
      yield* store.saveThread(ENVIRONMENT_ID, bounded);
      yield* store.saveThread(other, {
        ...bounded,
        snapshotSequence: 2,
        historyCursor: "other-cursor",
      });
      expect(
        Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID)).snapshotSequence,
      ).toBe(4);
      expect(Option.getOrThrow(yield* store.loadThread(other, THREAD_ID)).historyCursor).toBe(
        "other-cursor",
      );
      expect(Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID)).snapshotSequence).toBe(100);
    }),
  );
  it.effect("does not expose a cursor update when persistence fails", () =>
    Effect.gen(function* () {
      const { persistence, store } = yield* makePersistence;
      yield* store.saveThread(ENVIRONMENT_ID, bounded);
      const failedStore = yield* Store.make.pipe(
        Effect.provideService(Store.SnapshotSyncPersistence, {
          ...persistence,
          writeIfNewer: () =>
            Effect.fail(
              new Store.SnapshotSyncPersistenceError({ operation: "save", cause: "Disk full" }),
            ),
        }),
      );
      expect(
        yield* Effect.result(
          failedStore.saveThread(ENVIRONMENT_ID, {
            ...bounded,
            snapshotSequence: 5,
            historyCursor: "uncommitted",
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "SnapshotSyncPersistenceError" } });
      expect(Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID))).toEqual(
        bounded,
      );
    }),
  );
});
