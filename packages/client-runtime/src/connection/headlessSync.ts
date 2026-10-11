import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadShell,
} from "@supacode/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  type ConnectionAttemptError,
  ConnectionTransientError,
  type PreparedConnection,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionResolver from "./resolver.ts";
import {
  type ConnectionRouteKind,
  connectionRouteKind,
  connectionRoutes,
  entryWithRoutes,
  routeEntry,
} from "./routes.ts";
import * as Persistence from "../platform/persistence.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "../state/boundedThreadSnapshotHttp.ts";
import type { DeferredShellSnapshot } from "../state/shellPullRequests.ts";
import { fetchEnvironmentShellSnapshot } from "../state/shellSnapshotHttp.ts";

export interface HeadlessSyncOptions {
  /** Wall-clock budget for the whole run. Work that misses it waits for the next run. */
  readonly budgetMs: number;
  /** Thread snapshots refreshed per environment, most recently updated first. */
  readonly maxThreadsPerEnvironment?: number;
}

export interface HeadlessThreadSyncCounts {
  readonly selected: number;
  readonly refreshed: number;
  /** Already current in the cache, or the server returned nothing newer. */
  readonly skipped: number;
  readonly failed: number;
}

export type HeadlessEnvironmentSyncOutcome =
  | {
      readonly _tag: "synced";
      readonly routeKind: ConnectionRouteKind;
      readonly shellSequence: number;
      readonly threads: HeadlessThreadSyncCounts;
      /** False when the budget ran out before every selected thread was attempted. */
      readonly complete: boolean;
    }
  | { readonly _tag: "unreachable"; readonly error: ConnectionAttemptError }
  | {
      readonly _tag: "skipped";
      readonly reason: "disabled" | "no-direct-route" | "out-of-time";
    };

export interface HeadlessEnvironmentSyncReport {
  readonly environmentId: EnvironmentId;
  readonly outcome: HeadlessEnvironmentSyncOutcome;
}

export interface HeadlessSyncResult {
  readonly environments: ReadonlyArray<HeadlessEnvironmentSyncReport>;
  /** False when the budget ran out before every environment was attempted. */
  readonly complete: boolean;
}

/**
 * One read-only pass that refreshes the cached shell and recent thread
 * snapshots of every saved environment over HTTP. It reaches each environment
 * over the best direct route that answers right now, never opens a socket, and
 * never reports client activity, so the server does not see a foreground client.
 */
export class HeadlessSync extends Context.Service<
  HeadlessSync,
  {
    readonly run: (options: HeadlessSyncOptions) => Effect.Effect<HeadlessSyncResult>;
  }
>()("@supacode/client-runtime/connection/headlessSync") {}

const DEFAULT_MAX_THREADS_PER_ENVIRONMENT = 8;
const THREAD_FETCH_CONCURRENCY = 2;

type ThreadRefresh = "refreshed" | "skipped" | "failed" | "deferred";

function selectThreads(
  shell: OrchestrationV2ShellSnapshot,
  max: number,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  return shell.threads
    .filter((thread) => thread.deletedAt === null)
    .sort((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
    .slice(0, max);
}

function ranOutOfTime(outcome: HeadlessEnvironmentSyncOutcome): boolean {
  switch (outcome._tag) {
    case "synced":
      return !outcome.complete;
    case "skipped":
      return outcome.reason === "out-of-time";
    case "unreachable":
      return false;
  }
}

function countThreadRefreshes(outcomes: ReadonlyArray<ThreadRefresh>): HeadlessThreadSyncCounts {
  return {
    selected: outcomes.length,
    refreshed: outcomes.filter((outcome) => outcome === "refreshed").length,
    skipped: outcomes.filter((outcome) => outcome === "skipped").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
  };
}

// The shell arrives with pull request links deferred. The cache stores them on
// their rows, the same shape the foreground persists.
const withPullRequests = Effect.fnUntraced(function* (shell: DeferredShellSnapshot) {
  const { loadPullRequests, ...snapshot } = shell;
  if (loadPullRequests === undefined) return snapshot;
  const links = yield* loadPullRequests;
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => {
      const pullRequests = links.get(thread.id);
      return pullRequests === undefined ? thread : { ...thread, pullRequests };
    }),
  };
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const httpClient = yield* HttpClient.HttpClient;

  const remainingMs = (deadlineMs: number) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => deadlineMs - now));

  // The same route selection the supervisor uses, with an HTTP shell fetch in
  // place of a socket. A route that answers but cannot serve the shell hands
  // over to the next, so a LAN address saved on another network costs one check.
  const fetchShell = (entry: ConnectionCatalogEntry) =>
    ConnectionDriver.connectOverRoutes(
      entry,
      (route) => driver.checkRoute(entry, route),
      Effect.fnUntraced(function* (route) {
        const prepared = yield* resolver.prepare(routeEntry(entry, route));
        const shell = yield* fetchEnvironmentShellSnapshot({ prepared }).pipe(
          Effect.mapError(mapRemoteEnvironmentError),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        return { routeKind: connectionRouteKind(route), prepared, shell };
      }),
    );

  const persistShell = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    shell: DeferredShellSnapshot,
  ) {
    const cached = yield* cache
      .loadShell(environmentId)
      .pipe(Effect.orElseSucceed(() => Option.none<DeferredShellSnapshot>()));
    // A foreground session may have cached a newer shell since this run began.
    if (Option.isSome(cached) && cached.value.snapshotSequence >= shell.snapshotSequence) return;
    const snapshot = yield* withPullRequests(shell);
    yield* cache.saveShell(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Headless sync could not persist the environment shell.", {
          environmentId,
          error: error.message,
        }),
      ),
    );
  });

  const refreshThread = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    prepared: PreparedConnection,
    shellSequence: number,
    thread: OrchestrationV2ThreadShell,
    deadlineMs: number,
  ): Effect.fn.Return<ThreadRefresh> {
    const cached = yield* cache
      .loadThread(environmentId, thread.id)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationV2ThreadDetailSnapshot>()));
    const cachedSequence = Option.match(cached, {
      onNone: () => -1,
      onSome: (snapshot) => snapshot.snapshotSequence,
    });
    // Sequences are environment-wide, so a cached thread at the shell's
    // sequence cannot have missed an event.
    if (cachedSequence >= shellSequence) return "skipped";
    const remaining = yield* remainingMs(deadlineMs);
    if (remaining <= 0) return "deferred";
    const fetched = yield* fetchEnvironmentBoundedThreadSnapshot({
      prepared,
      threadId: thread.id,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.timeoutOption(remaining),
      Effect.result,
    );
    if (fetched._tag === "Failure") {
      if (fetched.failure._tag === "EnvironmentResourceNotFoundError") {
        yield* cache.removeThread(environmentId, thread.id).pipe(Effect.ignore);
        return "refreshed";
      }
      yield* Effect.logWarning("Headless sync could not refresh a thread.", {
        environmentId,
        threadId: thread.id,
        error: fetched.failure._tag,
      });
      return "failed";
    }
    if (Option.isNone(fetched.success)) return "deferred";
    const bounded = fetched.success.value;
    // Never move the cache backwards: the cached cursor is what the foreground
    // resumes from, and a lower one would replay events it already applied.
    if (bounded.snapshotSequence <= cachedSequence) return "skipped";
    return yield* cache
      .saveThread(environmentId, {
        snapshotSequence: bounded.snapshotSequence,
        projection: bounded.projection,
        historyCursor: bounded.historyCursor,
        hasMoreHistory: bounded.hasMoreHistory,
        latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
      })
      .pipe(
        Effect.as<ThreadRefresh>("refreshed"),
        Effect.catch((error) =>
          Effect.logWarning("Headless sync could not persist a thread snapshot.", {
            environmentId,
            threadId: thread.id,
            error: error.message,
          }).pipe(Effect.as<ThreadRefresh>("failed")),
        ),
      );
  });

  const syncEnvironment = Effect.fn("HeadlessSync.syncEnvironment")(function* (
    entry: ConnectionCatalogEntry,
    deadlineMs: number,
    maxThreads: number,
  ): Effect.fn.Return<HeadlessEnvironmentSyncOutcome> {
    const environmentId = entry.target.environmentId;
    yield* Effect.annotateCurrentSpan({ "connection.environment.id": environmentId });
    // Relay routes retain a tunnel for the app's lifetime and SSH needs the
    // desktop gateway; neither fits a short background slot yet.
    const direct = connectionRoutes(entry).filter((route) => {
      const kind = connectionRouteKind(route);
      return kind !== "relay" && kind !== "ssh";
    });
    if (direct.length === 0) return { _tag: "skipped", reason: "no-direct-route" };
    const remaining = yield* remainingMs(deadlineMs);
    if (remaining <= 0) return { _tag: "skipped", reason: "out-of-time" };
    const reached = yield* fetchShell(entryWithRoutes(entry, direct)).pipe(
      Effect.timeoutOrElse({
        duration: remaining,
        orElse: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "timeout",
              detail: `${entry.target.label} did not answer within the sync budget.`,
            }),
          ),
      }),
      Effect.scoped,
      Effect.result,
    );
    if (reached._tag === "Failure") {
      yield* Effect.logInfo("Headless sync could not reach the environment.", {
        environmentId,
        reason: reached.failure.reason,
      });
      return { _tag: "unreachable", error: reached.failure };
    }
    const { routeKind, prepared, shell } = reached.success;
    yield* persistShell(environmentId, shell);
    const outcomes = yield* Effect.forEach(
      selectThreads(shell, maxThreads),
      (thread) =>
        refreshThread(environmentId, prepared, shell.snapshotSequence, thread, deadlineMs),
      { concurrency: THREAD_FETCH_CONCURRENCY },
    );
    return {
      _tag: "synced",
      routeKind,
      shellSequence: shell.snapshotSequence,
      threads: countThreadRefreshes(outcomes),
      complete: !outcomes.includes("deferred"),
    };
  });

  const run = Effect.fn("HeadlessSync.run")(function* (options: HeadlessSyncOptions) {
    const deadlineMs = (yield* Clock.currentTimeMillis) + options.budgetMs;
    const maxThreads = options.maxThreadsPerEnvironment ?? DEFAULT_MAX_THREADS_PER_ENVIRONMENT;
    const entries = yield* SubscriptionRef.get(registry.entries);
    const environments: Array<HeadlessEnvironmentSyncReport> = [];
    // One environment at a time keeps a background slot's network use modest.
    for (const entry of entries.values()) {
      const outcome: HeadlessEnvironmentSyncOutcome = entry.enabled
        ? yield* syncEnvironment(entry, deadlineMs, maxThreads)
        : { _tag: "skipped", reason: "disabled" };
      environments.push({ environmentId: entry.target.environmentId, outcome });
    }
    return {
      environments,
      complete: !environments.some(({ outcome }) => ranOutOfTime(outcome)),
    } satisfies HeadlessSyncResult;
  });

  return HeadlessSync.of({ run });
});

export const layer = Layer.effect(HeadlessSync, make);
