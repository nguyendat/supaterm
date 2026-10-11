import {
  EnvironmentId,
  ThreadId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@supacode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
} from "../connection/catalog.ts";
import { ConnectionCredentialStore } from "../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import { RelayGateway, layer as relayGatewayLayer } from "../relay/gateway.ts";
import { BackgroundSnapshotStore, type BackgroundSnapshot, syncOnce } from "./sync.ts";

const environmentId = EnvironmentId.make("background-test");
const threadId = ThreadId.make("thread-1");
const relayAddress = `https://${"a".repeat(32)}.${"b".repeat(32)}.relay.supacode.invalid/`;
const route = (id: string, httpBaseUrl: string) => ({
  target: new BearerConnectionTarget({ environmentId, connectionId: id, label: id }),
  profile: Option.some(
    new BearerConnectionProfile({
      environmentId,
      connectionId: id,
      label: id,
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
    }),
  ),
});
const direct = route("direct", "https://host.example/");
const lan = route("lan", "http://192.168.1.2:4389/");
const tailnet = route("tailnet", "http://host.tailnet.ts.net/");
const relay = route("relay", relayAddress);
const entry: ConnectionCatalogEntry = {
  ...direct,
  enabled: true,
  alternateRoutes: [relay, tailnet, lan],
};
const descriptor = {
  environmentId,
  label: "Test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
};
const shell = {
  schemaVersion: 1,
  snapshotSequence: 9,
  projects: [],
  threads: [],
  archivedThreads: [],
};
const at = "2026-06-20T00:00:00.000Z";
const bounded = (id: string) => ({
  snapshotSequence: 12,
  projection: {
    thread: {
      createdBy: "user",
      creationSource: "mobile",
      id,
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
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
    updatedAt: at,
  },
  historyCursor: "history-page-2",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 20,
  payloadBudgetExceeded: false,
});

function harness(
  respond?: (url: URL, signal: AbortSignal) => Effect.Effect<Response>,
  release?: () => Promise<void>,
) {
  const requests: Array<{ url: URL; method: string; headers: Readonly<Record<string, string>> }> =
    [];
  const records: BackgroundSnapshot[] = [];
  const closed: string[] = [];
  const retained: string[] = [];
  const opened: string[] = [];
  const client = HttpClient.make((request, url, signal) => {
    requests.push({ url, method: request.method, headers: request.headers });
    const response = respond?.(url, signal) ?? Effect.succeed(defaultResponse(url));
    return response.pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)));
  });
  const gateway = RelayGateway.of({
    available: true,
    fetch: globalThis.fetch,
    resolve: () => Promise.reject(new Error("Sync must not retain a relay")),
    release: () => Promise.reject(new Error("Sync must release only its lease")),
    lease: (address) => {
      opened.push(address);
      return {
        prepare: () => Promise.resolve("http://127.0.0.1:4444/"),
        retain: () => {
          retained.push(address);
        },
        close: async () => {
          closed.push(address);
          await release?.();
        },
      };
    },
  });
  const credentials = ConnectionCredentialStore.of({
    get: () => Effect.succeedSome(new BearerConnectionCredential({ token: "test-secret" })),
    put: () => Effect.die("Cannot write credentials"),
    remove: () => Effect.die("Cannot remove credentials"),
  });
  const store = BackgroundSnapshotStore.of({
    save: (id, record) =>
      Effect.sync(() => {
        expect(id).toBe(environmentId);
        records.push(record);
        return true;
      }),
  });
  const run = (input: Partial<Parameters<typeof syncOnce>[0]> = {}, transport = gateway) =>
    syncOnce({ entry, threadIds: [threadId], ...input }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(ConnectionCredentialStore, credentials),
      Effect.provideService(RelayGateway, transport),
      Effect.provideService(BackgroundSnapshotStore, store),
    );
  return { run, requests, records, opened, closed, retained };
}

function defaultResponse(url: URL) {
  if (url.pathname.startsWith("/.well-known/")) return Response.json(descriptor);
  if (url.pathname === "/api/orchestration/shell") return Response.json(shell);
  if (url.pathname.endsWith("/bounded")) return Response.json(bounded(url.pathname.split("/")[4]!));
  throw new Error(`Unexpected request: ${url.pathname}`);
}

describe("headless background sync", () => {
  it.effect(
    "prefers reachable LAN over a saved public primary and persists bounded cursors with their sequences",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const result = yield* h.run();
        expect(result).toEqual({
          environmentId,
          routeId: "lan",
          shell: { status: "saved", snapshotSequence: 9 },
          threads: [{ threadId, status: "saved", snapshotSequence: 12 }],
          omittedThreadCount: 0,
        });
        expect(h.records).toMatchObject([
          { kind: "shell", snapshot: { snapshotSequence: 9 } },
          {
            kind: "thread",
            snapshot: {
              snapshotSequence: 12,
              historyCursor: "history-page-2",
              hasMoreHistory: true,
              latestLocalTurnOrdinal: 20,
            },
          },
        ]);
        expect(h.opened).toEqual(h.closed);
        expect(h.retained).toEqual([]);
        for (const request of h.requests) {
          expect(request.method).toBe("GET");
          expect(request.url.searchParams.has("clientId")).toBe(false);
          if (request.url.pathname.startsWith("/.well-known/"))
            expect(request.headers.authorization).toBeUndefined();
          else {
            expect(request.url.hostname).toBe("192.168.1.2");
            expect(request.headers.authorization).toBe("Bearer test-secret");
            expect(request.headers[ORCHESTRATION_PROTOCOL_HEADER]).toBe(
              String(ORCHESTRATION_PROTOCOL_VERSION),
            );
          }
        }
      }),
  );

  it.effect.each([
    ["tailnet", ["192.168.1.2"]],
    ["direct", ["192.168.1.2", "host.tailnet.ts.net"]],
    ["relay", ["192.168.1.2", "host.tailnet.ts.net", "host.example"]],
  ] as const)(
    "falls back to %s when preferred routes reject snapshot reads",
    ([expected, unavailable]) =>
      Effect.gen(function* () {
        const h = harness((url) =>
          Effect.succeed(
            unavailable.some((host) => host === url.hostname) && url.pathname.startsWith("/api/")
              ? new Response("unavailable", { status: 503 })
              : defaultResponse(url),
          ),
        );
        const result = yield* h.run();
        expect(result.routeId).toBe(expected);
        expect(h.records).toHaveLength(2);
        expect(h.closed).toEqual(h.opened);
      }),
  );

  it.effect("skips a silent LAN probe after the preference window and cancels it on success", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let signal: AbortSignal | undefined;
      const h = harness((url, current) =>
        url.hostname === "192.168.1.2"
          ? Effect.sync(() => {
              signal = current;
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
            )
          : Effect.succeed(defaultResponse(url)),
      );
      const fiber = yield* h.run().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(300);
      expect((yield* Fiber.join(fiber)).routeId).toBe("tailnet");
      expect(signal?.aborted).toBe(true);
      expect(h.opened).toEqual(h.closed);
    }),
  );

  it.effect("never sends credentials to a different environment at a saved address", () =>
    Effect.gen(function* () {
      const h = harness((url) =>
        Effect.succeed(
          url.hostname === "192.168.1.2"
            ? Response.json({ ...descriptor, environmentId: "another-environment" })
            : defaultResponse(url),
        ),
      );
      expect((yield* h.run()).routeId).toBe("tailnet");
      expect(
        h.requests
          .filter((request) => request.url.hostname === "192.168.1.2")
          .every((request) => request.headers.authorization === undefined),
      ).toBe(true);
    }),
  );

  it.effect.each(["deadline", "interruption"] as const)(
    "aborts in-flight HTTP and releases the relay on %s",
    (mode) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let signal: AbortSignal | undefined;
        const h = harness((url, current) =>
          url.pathname === "/api/orchestration/shell"
            ? Effect.sync(() => {
                signal = current;
              }).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
              )
            : Effect.succeed(defaultResponse(url)),
        );
        const fiber = yield* h
          .run({ entry: { ...relay, enabled: true }, budgetMs: 100 })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        if (mode === "deadline") {
          yield* TestClock.adjust(100);
          expect(yield* Fiber.join(fiber)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "timeout" },
          });
        } else yield* Fiber.interrupt(fiber);
        expect(signal?.aborted).toBe(true);
        expect(h.records).toEqual([]);
        expect(h.opened).toEqual([relayAddress]);
        expect(h.closed).toEqual(h.opened);
        expect(h.retained).toEqual([]);
      }),
  );

  it.effect("deduplicates and caps selection without fetching full history", () =>
    Effect.gen(function* () {
      const h = harness();
      const ids = Array.from({ length: 7 }, (_, i) => ThreadId.make(`thread-${i}`));
      const result = yield* h.run({ threadIds: [ids[0]!, ...ids] });
      expect(result.threads).toHaveLength(5);
      expect(result.omittedThreadCount).toBe(2);
      const reads = h.requests.filter((request) => request.url.pathname.includes("/threads/"));
      expect(reads).toHaveLength(5);
      expect(
        reads.every(
          (request) =>
            request.url.pathname.endsWith("/bounded") &&
            request.url.searchParams.get("compactTurnItems") === "1",
        ),
      ).toBe(true);
    }),
  );

  it.effect("reports a deleted selected thread without inventing a snapshot cursor", () =>
    Effect.gen(function* () {
      const h = harness((url) =>
        Effect.succeed(
          url.pathname.endsWith("/bounded")
            ? Response.json(
                {
                  _tag: "EnvironmentResourceNotFoundError",
                  code: "not_found",
                  reason: "thread_not_found",
                  traceId: "test-trace",
                },
                { status: 404 },
              )
            : defaultResponse(url),
        ),
      );
      expect((yield* h.run()).threads).toEqual([{ threadId, status: "missing" }]);
      expect(h.records).toHaveLength(1);
    }),
  );

  it.effect("bounds stalled relay cleanup and does not claim a persisted result", () =>
    Effect.gen(function* () {
      const closing = yield* Deferred.make<void>();
      const h = harness(undefined, () => {
        Deferred.doneUnsafe(closing, Effect.void);
        return new Promise<void>(() => {});
      });
      const fiber = yield* h
        .run({ entry: { ...relay, enabled: true } })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(closing);
      yield* TestClock.adjust(1_000);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "timeout",
          detail: "Background relay cleanup exceeded its grace period.",
        },
      });
      expect(h.records).toEqual([]);
    }),
  );

  it.effect("reserves cleanup time inside the requested deadline", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const h = harness(
        (url) =>
          url.pathname === "/api/orchestration/shell"
            ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(defaultResponse(url)),
        () => {
          Deferred.doneUnsafe(closing, Effect.void);
          return new Promise<void>(() => {});
        },
      );
      const fiber = yield* h
        .run({ entry: { ...relay, enabled: true }, budgetMs: 100 })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(reading);
      yield* TestClock.adjust(75);
      yield* Deferred.await(closing);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(25);
      expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
      expect(h.records).toEqual([]);
    }),
  );

  it.effect("leaves persistence untouched when every route fails", () =>
    Effect.gen(function* () {
      const h = harness((url) =>
        Effect.succeed(
          url.pathname.startsWith("/api/")
            ? new Response("unavailable", { status: 503 })
            : defaultResponse(url),
        ),
      );
      expect(yield* h.run().pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      expect(h.records).toEqual([]);
      expect(h.opened).toEqual(h.closed);
    }),
  );

  it.effect("releases its lease without stopping a relay retained by the foreground", () =>
    Effect.gen(function* () {
      let closes = 0;
      const layer = relayGatewayLayer({
        fetch: globalThis.fetch,
        open: async () => ({
          prepare: async () => "http://127.0.0.1:4444/",
          close: async () => {
            closes++;
          },
        }),
      });
      yield* Effect.gen(function* () {
        const gateway = yield* RelayGateway;
        yield* Effect.promise(() => gateway.resolve(relayAddress));
        const h = harness();
        expect((yield* h.run({ entry: { ...relay, enabled: true } }, gateway)).routeId).toBe(
          "relay",
        );
        expect(closes).toBe(0);
      }).pipe(Effect.provide(layer));
      expect(closes).toBe(1);
    }),
  );

  it.effect("does no network or persistence work for a disabled environment", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(
        yield* h.run({ entry: { ...entry, enabled: false } }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "configuration" } });
      expect(h.requests).toEqual([]);
      expect(h.records).toEqual([]);
    }),
  );
});
