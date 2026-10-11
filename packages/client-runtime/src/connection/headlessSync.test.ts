import {
  EnvironmentId,
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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import * as HeadlessSync from "./headlessSync.ts";
import { BearerConnectionTarget, type NetworkStatus, type PreparedConnection } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "../state/orchestrationV2TestFixtures.ts";

const ENVIRONMENT_ID = EnvironmentId.make("sync-test");
const LAN_HOST = "192.168.1.2:4389";
const TAILNET_HOST = "100.100.1.2:4389";

function route(
  environmentId: EnvironmentId,
  id: string,
  httpBaseUrl: string,
  network?: "tailscale",
): ConnectionRoute {
  const target = new BearerConnectionTarget({ connectionId: id, environmentId, label: "Test" });
  return {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId,
        label: target.label,
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace("http", "ws"),
        ...(network === undefined ? {} : { network }),
      }),
    ),
  };
}
const lan = route(ENVIRONMENT_ID, "lan", `http://${LAN_HOST}/`);
const tailnet = route(ENVIRONMENT_ID, "tailnet", `http://${TAILNET_HOST}/`, "tailscale");
const entry: ConnectionCatalogEntry = { ...lan, enabled: true, alternateRoutes: [tailnet] };

const at = (iso: string) => DateTime.makeUnsafe(iso);
const thread = (id: string, updatedAt: string): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  id: ThreadId.make(id),
  lineage: { ...v2ThreadShell.lineage, rootThreadId: ThreadId.make(id) },
  updatedAt: at(updatedAt),
});
const NEWEST = ThreadId.make("newest");
const MIDDLE = ThreadId.make("middle");
const OLDEST = ThreadId.make("oldest");
const SHELL: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 12,
  threads: [
    thread("oldest", "2026-06-01T00:00:00.000Z"),
    { ...thread("deleted", "2026-06-30T00:00:00.000Z"), deletedAt: at("2026-06-30T00:00:00.000Z") },
    thread("newest", "2026-06-20T00:00:00.000Z"),
    thread("middle", "2026-06-10T00:00:00.000Z"),
  ],
};
const encodeShell = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot));
const encodeBounded = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot));

const boundedBody = (threadId: ThreadId, snapshotSequence: number) =>
  encodeBounded({
    snapshotSequence,
    projection: {
      ...v2Projection,
      thread: {
        ...v2Projection.thread,
        id: threadId,
        lineage: { ...v2Projection.thread.lineage, rootThreadId: threadId },
      },
    },
    historyCursor: `cursor-${threadId}`,
    hasMoreHistory: true,
    latestLocalTurnOrdinal: 3,
  });
const cachedThread = (
  threadId: ThreadId,
  snapshotSequence: number,
): OrchestrationV2ThreadDetailSnapshot => ({
  snapshotSequence,
  projection: { ...v2Projection, thread: { ...v2Projection.thread, id: threadId } },
});

const json = (body: unknown, status = 200) => Response.json(body, { status });
const unavailable = () => new Response("Service Unavailable", { status: 503 });
const THREAD_NOT_FOUND = {
  _tag: "EnvironmentResourceNotFoundError",
  code: "not_found",
  reason: "thread_not_found",
  traceId: "trace-missing",
};

interface Responder {
  readonly shell?: (host: string) => Response;
  readonly bounded?: (threadId: ThreadId, host: string) => Effect.Effect<Response>;
}

const threadIdOf = (pathname: string) =>
  ThreadId.make(pathname.replace("/api/orchestration/threads/", "").replace("/bounded", ""));

const unused = () => Effect.die("Headless sync must not use this.");

const makeHarness = Effect.fnUntraced(function* (input: {
  readonly entries?: ReadonlyArray<ConnectionCatalogEntry>;
  readonly check: (route: ConnectionRoute) => Effect.Effect<ConnectionDriver.RouteCheck>;
  readonly respond: Responder;
  readonly cachedShell?: OrchestrationV2ShellSnapshot;
  readonly cachedThreads?: ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>;
}) {
  const requests = yield* Ref.make<ReadonlyArray<string>>([]);
  const shells = new Map<string, OrchestrationV2ShellSnapshot>();
  if (input.cachedShell) shells.set(ENVIRONMENT_ID, input.cachedShell);
  const threads = new Map<string, OrchestrationV2ThreadDetailSnapshot>();
  for (const cached of input.cachedThreads ?? []) threads.set(cached.projection.thread.id, cached);

  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map((input.entries ?? [entry]).map((item) => [item.target.environmentId, item])),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: unused,
    registerPlatform: unused,
    reconcilePlatform: unused,
    remove: unused,
    removeRoute: unused,
    reorderRoutes: unused,
    retryNow: unused,
    setEnabled: unused,
    setCompatibility: unused,
    state: unused,
    stateChanges: () => Stream.die("Headless sync must not use this."),
    run: unused,
    runStream: () => Stream.die("Headless sync must not use this."),
    followStream: () => Stream.die("Headless sync must not use this."),
  });
  const driver = ConnectionDriver.ConnectionDriver.of({
    connect: () => Effect.die("Headless sync must not open a socket."),
    preflight: () => Effect.die("Headless sync must not preflight."),
    checkRoute: (_entry, candidate) => input.check(candidate),
  });
  const resolver = ConnectionResolver.ConnectionResolver.of({
    prepare: (prepared) => {
      const profile = Option.getOrThrow(prepared.profile);
      if (profile._tag !== "BearerConnectionProfile") return Effect.die("Bearer routes only.");
      return Effect.succeed({
        environmentId: prepared.target.environmentId,
        label: prepared.target.label,
        httpBaseUrl: profile.httpBaseUrl,
        socketUrl: `${profile.wsBaseUrl}ws?wsTicket=unused`,
        httpAuthorization: { _tag: "Bearer", token: "token" },
        target: prepared.target,
      } satisfies PreparedConnection);
    },
    prepareForUpdate: unused,
  });
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(requests, (current) => [...current, request.url]);
      const url = new URL(request.url);
      if (url.pathname === "/api/orchestration/shell") {
        const shell = input.respond.shell ?? (() => json(encodeShell(SHELL)));
        return HttpClientResponse.fromWeb(request, shell(url.host));
      }
      const bounded =
        input.respond.bounded ?? ((threadId) => Effect.succeed(json(boundedBody(threadId, 12))));
      const response = yield* bounded(threadIdOf(url.pathname), url.host);
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: (environmentId) => Effect.succeed(Option.fromUndefinedOr(shells.get(environmentId))),
    saveShell: (environmentId, snapshot) =>
      Effect.sync(() => void shells.set(environmentId, snapshot)),
    loadThread: (_environmentId, threadId) =>
      Effect.succeed(Option.fromUndefinedOr(threads.get(threadId))),
    saveThread: (_environmentId, snapshot) =>
      Effect.sync(() => void threads.set(snapshot.projection.thread.id, snapshot)),
    removeThread: (_environmentId, threadId) => Effect.sync(() => void threads.delete(threadId)),
    loadServerConfig: unused,
    saveServerConfig: unused,
    loadVcsRefs: unused,
    saveVcsRefs: unused,
    removeVcsRefs: unused,
    clearVcsRefs: unused,
    clear: unused,
  });
  const sync = yield* HeadlessSync.make.pipe(
    Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
    Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
    Effect.provideService(ConnectionResolver.ConnectionResolver, resolver),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );
  return { sync, requests, shells, threads };
});

const hostsOf = (urls: ReadonlyArray<string>) => new Set(urls.map((url) => new URL(url).host));
const boundedRequests = (urls: ReadonlyArray<string>) =>
  urls.flatMap((url) => (url.includes("/bounded") ? [threadIdOf(new URL(url).pathname)] : []));

describe("headless one-shot sync", () => {
  it.effect("refreshes the shell and the most recent threads over the route that answers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        check: (candidate) => Effect.succeed(candidate === tailnet ? "answered" : "silent"),
        respond: {},
      });
      const result = yield* harness.sync.run({ budgetMs: 10_000, maxThreadsPerEnvironment: 2 });
      expect(result).toEqual({
        complete: true,
        environments: [
          {
            environmentId: ENVIRONMENT_ID,
            outcome: {
              _tag: "synced",
              routeKind: "tailnet",
              shellSequence: 12,
              complete: true,
              threads: { selected: 2, refreshed: 2, skipped: 0, failed: 0 },
            },
          },
        ],
      });
      const urls = yield* Ref.get(harness.requests);
      expect(hostsOf(urls)).toEqual(new Set([TAILNET_HOST]));
      expect(new Set(boundedRequests(urls))).toEqual(new Set([NEWEST, MIDDLE]));
      expect(harness.shells.get(ENVIRONMENT_ID)?.snapshotSequence).toBe(12);
      expect(harness.threads.get(NEWEST)).toMatchObject({
        snapshotSequence: 12,
        historyCursor: `cursor-${NEWEST}`,
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 3,
      });
      expect(harness.threads.has(OLDEST)).toBe(false);
    }),
  );

  it.effect("falls back to the next route when the preferred one cannot serve the shell", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        check: () => Effect.succeed("answered"),
        respond: {
          shell: (host) => (host === LAN_HOST ? unavailable() : json(encodeShell(SHELL))),
        },
      });
      const result = yield* harness.sync.run({ budgetMs: 10_000, maxThreadsPerEnvironment: 1 });
      expect(result.environments[0]?.outcome).toMatchObject({
        _tag: "synced",
        routeKind: "tailnet",
      });
      const urls = yield* Ref.get(harness.requests);
      expect(urls.filter((url) => url.endsWith("/api/orchestration/shell"))).toEqual([
        `http://${LAN_HOST}/api/orchestration/shell`,
        `http://${TAILNET_HOST}/api/orchestration/shell`,
      ]);
      expect(hostsOf(urls.filter((url) => url.includes("/bounded")))).toEqual(
        new Set([TAILNET_HOST]),
      );
    }),
  );

  it.effect("reports the environment unreachable when no route serves the shell", () =>
    Effect.gen(function* () {
      const relayOnly: ConnectionCatalogEntry = {
        ...route(
          EnvironmentId.make("relay-only"),
          "relay",
          `https://${"11".repeat(16)}.${"22".repeat(16)}.relay.supacode.invalid/`,
        ),
        enabled: true,
      };
      const disabled: ConnectionCatalogEntry = {
        ...route(EnvironmentId.make("disabled"), "lan", "http://10.0.0.5:4389/"),
        enabled: false,
      };
      const harness = yield* makeHarness({
        entries: [entry, relayOnly, disabled],
        check: () => Effect.succeed("silent"),
        respond: { shell: unavailable },
      });
      const result = yield* harness.sync.run({ budgetMs: 10_000 });
      expect(result.complete).toBe(true);
      expect(result.environments.map(({ outcome }) => outcome)).toMatchObject([
        { _tag: "unreachable", error: { _tag: "ConnectionTransientError" } },
        { _tag: "skipped", reason: "no-direct-route" },
        { _tag: "skipped", reason: "disabled" },
      ]);
      expect(hostsOf(yield* Ref.get(harness.requests))).toEqual(new Set([LAN_HOST, TAILNET_HOST]));
      expect(harness.shells.size).toBe(0);
    }),
  );

  it.effect("keeps the shell and stops refreshing threads when the budget runs out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        check: () => Effect.succeed("answered"),
        respond: {
          bounded: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        },
      });
      const fiber = yield* harness.sync.run({ budgetMs: 5_000 }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(5_000);
      const result = yield* Fiber.join(fiber);
      expect(result.complete).toBe(false);
      expect(result.environments[0]?.outcome).toMatchObject({
        _tag: "synced",
        complete: false,
        threads: { selected: 3, refreshed: 0, skipped: 0, failed: 0 },
      });
      expect(harness.shells.get(ENVIRONMENT_ID)?.snapshotSequence).toBe(12);
      expect(harness.threads.size).toBe(0);
    }),
  );

  it.effect("interrupting the run cancels in-flight requests and writes nothing more", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        check: () => Effect.succeed("answered"),
        respond: {
          bounded: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        },
      });
      const fiber = yield* harness.sync.run({ budgetMs: 60_000 }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      yield* Deferred.await(interrupted);
      expect(harness.shells.get(ENVIRONMENT_ID)?.snapshotSequence).toBe(12);
      expect(harness.threads.size).toBe(0);
    }),
  );

  it.effect("never moves a cached snapshot backwards and skips threads already current", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        check: () => Effect.succeed("answered"),
        respond: {
          bounded: (threadId) =>
            Effect.succeed(json(boundedBody(threadId, threadId === MIDDLE ? 9 : 12))),
        },
        cachedShell: { ...SHELL, snapshotSequence: 20 },
        cachedThreads: [cachedThread(NEWEST, 20), cachedThread(MIDDLE, 10)],
      });
      const result = yield* harness.sync.run({ budgetMs: 10_000 });
      expect(result.environments[0]?.outcome).toMatchObject({
        _tag: "synced",
        shellSequence: 12,
        threads: { selected: 3, refreshed: 1, skipped: 2, failed: 0 },
      });
      expect(boundedRequests(yield* Ref.get(harness.requests))).toEqual([MIDDLE, OLDEST]);
      expect(harness.shells.get(ENVIRONMENT_ID)?.snapshotSequence).toBe(20);
      expect(harness.threads.get(NEWEST)?.snapshotSequence).toBe(20);
      expect(harness.threads.get(MIDDLE)?.snapshotSequence).toBe(10);
      expect(harness.threads.get(OLDEST)?.snapshotSequence).toBe(12);
    }),
  );

  it.effect("drops the cache of a thread the server no longer has and counts other failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        check: () => Effect.succeed("answered"),
        respond: {
          bounded: (threadId) => {
            if (threadId === MIDDLE) return Effect.succeed(json(THREAD_NOT_FOUND, 404));
            if (threadId === OLDEST) return Effect.succeed(unavailable());
            return Effect.succeed(json(boundedBody(threadId, 12)));
          },
        },
        cachedThreads: [cachedThread(MIDDLE, 5)],
      });
      const result = yield* harness.sync.run({ budgetMs: 10_000 });
      expect(result.environments[0]?.outcome).toMatchObject({
        _tag: "synced",
        complete: true,
        threads: { selected: 3, refreshed: 2, skipped: 0, failed: 1 },
      });
      expect(harness.threads.has(MIDDLE)).toBe(false);
      expect(harness.threads.get(NEWEST)?.snapshotSequence).toBe(12);
    }),
  );
});
