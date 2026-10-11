import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@supacode/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import type { EnvironmentHttpEndpoint } from "../connection/model.ts";
import { loadPersistedCatalogEntries } from "../connection/persistedCatalog.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import {
  type ConnectionRouteKind,
  connectionRouteId,
  connectionRouteKind,
} from "../connection/routes.ts";
import * as Persistence from "../platform/persistence.ts";
import { RelayGateway } from "../relay/gateway.ts";
import { loadThreadSnapshotOverHttp } from "../state/boundedThreadSnapshotHttp.ts";
import type { DeferredShellSnapshot } from "../state/shellPullRequests.ts";
import { mergeShellSnapshotProjects } from "../state/shellReducer.ts";
import { fetchEnvironmentShellSnapshot } from "../state/shellSnapshotHttp.ts";
import {
  historyFromHttpSnapshot,
  shouldPersistThread,
  snapshotToPersist,
} from "../state/threadCachePolicy.ts";
import { openHttpRoute } from "./httpRoute.ts";

export const DEFAULT_MAX_THREADS_PER_ENVIRONMENT = 5;
const MAX_PRIORITY_THREADS_PER_ENVIRONMENT = 3;
const THREAD_FETCH_CONCURRENCY = 2;

export interface BackgroundSyncThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface BackgroundSyncRequest {
  /** How long the run may take before it stops and reports what it saved. */
  readonly budgetMs: number;
  /** Threads to refresh before the recent window, such as the thread a notification named. */
  readonly priorityThreads?: ReadonlyArray<BackgroundSyncThreadRef>;
  /** Size of the recently updated window kept fresh per environment. */
  readonly maxThreadsPerEnvironment?: number;
  /** Stops the run early, for example when the operating system expires the task. */
  readonly signal?: AbortSignal;
}

export type CacheWriteResult =
  | { readonly _tag: "saved"; readonly sequence: number; readonly previousSequence: number | null }
  | { readonly _tag: "unchanged"; readonly sequence: number }
  | { readonly _tag: "stale"; readonly sequence: number; readonly cachedSequence: number }
  | { readonly _tag: "superseded"; readonly sequence: number };

export type ThreadSyncResult =
  | CacheWriteResult
  /** A run is in progress; the thread cache never holds one, so it was not written. */
  | { readonly _tag: "active"; readonly sequence: number }
  | { readonly _tag: "removed" }
  | { readonly _tag: "preserved" }
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "not-reached" };

export interface EnvironmentSyncReport {
  readonly environmentId: EnvironmentId;
  readonly status: "synced" | "unreachable" | "failed" | "stopped";
  readonly route: { readonly id: string; readonly kind: ConnectionRouteKind } | null;
  readonly shell: CacheWriteResult | null;
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly result: ThreadSyncResult;
  }>;
  readonly error: string | null;
}

export interface BackgroundSyncReport {
  /**
   * `deadline` and `cancelled` keep everything saved before the stop; each
   * snapshot is written together with its sequence, so a stop never leaves a
   * cursor ahead of its data. `busy` means the task runner was already running one.
   */
  readonly outcome: "completed" | "deadline" | "cancelled" | "busy" | "failed";
  readonly durationMs: number;
  readonly environments: ReadonlyArray<EnvironmentSyncReport>;
  readonly error: string | null;
}

export class BackgroundSync extends Context.Service<
  BackgroundSync,
  {
    /**
     * Refreshes cached shells and a bounded set of thread snapshots once, over
     * HTTP only. It opens no socket, reports no client presence, and sends no
     * commands. Never fails; the report says what was saved. Runs must not
     * overlap; `BackgroundSyncTask.makeTaskRunner` enforces that for platform tasks.
     */
    readonly run: (request: BackgroundSyncRequest) => Effect.Effect<BackgroundSyncReport>;
  }
>()("@supacode/client-runtime/backgroundSync/backgroundSync") {}

const ACTIVE_THREAD_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "preparing",
  "starting",
  "running",
]);

/**
 * The window background sync keeps fresh: the most recently updated threads
 * without a run in progress. The thread cache never holds a running thread.
 */
export function recentSettledThreads(
  shell: OrchestrationV2ShellSnapshot,
  limit: number,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  return shell.threads
    .filter((thread) => thread.deletedAt === null && !ACTIVE_THREAD_STATUSES.has(thread.status))
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    )
    .slice(0, limit);
}

/**
 * Every applied event stamps its time on the thread, so a shell row newer than
 * the cached detail means the detail missed events. Comparing against the
 * detail rather than the previous shell keeps a thread selected until a sync
 * actually stores it.
 */
export function isThreadDetailStale(
  row: OrchestrationV2ThreadShell,
  cached: Option.Option<OrchestrationV2ThreadDetailSnapshot>,
): boolean {
  if (Option.isNone(cached)) return true;
  const { projection } = cached.value;
  const cachedAt = Math.max(
    DateTime.toEpochMillis(projection.updatedAt),
    DateTime.toEpochMillis(projection.thread.updatedAt),
  );
  return DateTime.toEpochMillis(row.updatedAt) > cachedAt;
}

const cachedSequenceOf = (cached: Option.Option<{ readonly snapshotSequence: number }>) =>
  Option.getOrNull(Option.map(cached, (snapshot) => snapshot.snapshotSequence));

function mergeEqualSequenceShellSnapshot(
  cached: OrchestrationV2ShellSnapshot,
  fetched: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  const cachedThreads = new Map(cached.threads.map((thread) => [thread.id, thread] as const));
  return {
    ...fetched,
    threads: fetched.threads.map((thread) => {
      const prior = cachedThreads.get(thread.id);
      return thread.pullRequests === undefined && prior?.pullRequests !== undefined
        ? { ...thread, pullRequests: prior.pullRequests }
        : thread;
    }),
  };
}

function mergeEqualSequenceThreadSnapshot(
  cached: OrchestrationV2ThreadDetailSnapshot,
  fetched: OrchestrationV2ThreadDetailSnapshot,
): OrchestrationV2ThreadDetailSnapshot {
  const localOrdinals = [cached.latestLocalTurnOrdinal, fetched.latestLocalTurnOrdinal].filter(
    (value): value is number => typeof value === "number",
  );
  return {
    ...fetched,
    historyCursor: cached.historyCursor ?? fetched.historyCursor ?? null,
    hasMoreHistory: cached.hasMoreHistory === true || fetched.hasMoreHistory === true,
    latestLocalTurnOrdinal: localOrdinals.length === 0 ? null : Math.max(...localOrdinals),
  };
}

const completeShellSnapshot = Effect.fnUntraced(function* (
  fetched: DeferredShellSnapshot,
  cached: OrchestrationV2ShellSnapshot | null,
) {
  const { loadPullRequests, ...snapshot } = fetched;
  const links = loadPullRequests === undefined ? new Map() : yield* loadPullRequests;
  const threads = snapshot.threads.map((thread) => {
    const pullRequests = links.get(thread.id);
    return pullRequests === undefined ? thread : { ...thread, pullRequests };
  });
  return mergeShellSnapshotProjects(cached, { ...snapshot, threads });
});

function abortion(signal: AbortSignal) {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

interface EnvironmentProgress {
  status: EnvironmentSyncReport["status"];
  route: EnvironmentSyncReport["route"];
  shell: CacheWriteResult | null;
  readonly threads: Map<ThreadId, ThreadSyncResult>;
  error: string | null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const cache = yield* Persistence.EnvironmentCacheStore;
  const targets = yield* Persistence.ConnectionTargetStore;
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const httpClient = yield* HttpClient.HttpClient;
  const relay = yield* Effect.serviceOption(RelayGateway);

  const provideDependencies = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Persistence.ConnectionTargetStore
      | ConnectionProfileStore.ConnectionProfileStore
      | ConnectionCredentialStore.ConnectionCredentialStore
      | HttpClient.HttpClient
    >,
  ): Effect.Effect<A, E> => {
    const provided = effect.pipe(
      Effect.provideService(Persistence.ConnectionTargetStore, targets),
      Effect.provideService(ConnectionProfileStore.ConnectionProfileStore, profiles),
      Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Option.isSome(relay)
      ? Effect.provideService(provided, RelayGateway, relay.value)
      : provided;
  };

  const loadCachedThread = (environmentId: EnvironmentId, threadId: ThreadId) =>
    cache
      .loadThread(environmentId, threadId)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not read a cached thread during background sync.").pipe(
            Effect.annotateLogs({ environmentId, threadId, error: error.message }),
            Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
          ),
        ),
      );

  const cacheWriteResult = (
    sequence: number,
    cachedSequence: number | null,
    saved: boolean,
  ): CacheWriteResult => {
    if (saved) return { _tag: "saved", sequence, previousSequence: cachedSequence };
    if (cachedSequence === sequence) return { _tag: "unchanged", sequence };
    return { _tag: "superseded", sequence };
  };

  const saveIfNewer = (
    sequence: number,
    cachedSequence: number | null,
    write: Effect.Effect<boolean, Persistence.ConnectionPersistenceError>,
    record: (result: CacheWriteResult) => void,
  ) => {
    if (cachedSequence === null || cachedSequence <= sequence) {
      return Effect.uninterruptible(
        write.pipe(
          Effect.flatMap((saved) =>
            Effect.sync(() => record(cacheWriteResult(sequence, cachedSequence, saved))),
          ),
        ),
      );
    }
    return Effect.sync(() =>
      record(
        cachedSequence === sequence
          ? { _tag: "unchanged", sequence }
          : { _tag: "stale", sequence, cachedSequence },
      ),
    );
  };

  const syncThread = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    endpoint: EnvironmentHttpEndpoint,
    threadId: ThreadId,
    record: (result: ThreadSyncResult) => void,
  ) {
    const loaded = yield* loadThreadSnapshotOverHttp(endpoint, threadId);
    switch (loaded._tag) {
      case "unavailable":
        record({ _tag: "unavailable" });
        return;
      case "missing": {
        const cached = yield* loadCachedThread(environmentId, threadId);
        const cachedSequence = cachedSequenceOf(cached);
        const removed = yield* Effect.uninterruptible(
          cache.removeThreadIfSequence?.(environmentId, threadId, cachedSequence) ??
            (cachedSequence === null
              ? Effect.succeed(false)
              : cache.removeThread(environmentId, threadId).pipe(Effect.as(true))),
        );
        record(removed ? { _tag: "removed" } : { _tag: "preserved" });
        return;
      }
      case "present": {
        const { snapshot } = loaded;
        const history = historyFromHttpSnapshot(loaded.history);
        if (!shouldPersistThread(snapshot.projection, history)) {
          record({ _tag: "active", sequence: snapshot.snapshotSequence });
          return;
        }
        const cached = yield* loadCachedThread(environmentId, threadId);
        const persisted = snapshotToPersist(
          snapshot.snapshotSequence,
          snapshot.projection,
          history,
          true,
        );
        const persistedToSave =
          cachedSequenceOf(cached) === persisted.snapshotSequence && Option.isSome(cached)
            ? mergeEqualSequenceThreadSnapshot(cached.value, persisted)
            : persisted;
        yield* saveIfNewer(
          persistedToSave.snapshotSequence,
          cachedSequenceOf(cached),
          cache.saveThreadIfNewer?.(environmentId, persistedToSave) ??
            (cachedSequenceOf(cached) === persistedToSave.snapshotSequence
              ? Effect.succeed(false)
              : cache.saveThread(environmentId, persistedToSave).pipe(Effect.as(true))),
          record,
        );
      }
    }
  });

  const syncEnvironment = Effect.fnUntraced(function* (
    entry: ConnectionCatalogEntry,
    progress: EnvironmentProgress,
    priority: ReadonlyArray<ThreadId>,
    limit: number,
  ) {
    const environmentId = entry.target.environmentId;
    const opened = yield* openHttpRoute(entry, (endpoint) =>
      fetchEnvironmentShellSnapshot({ prepared: endpoint }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
      ),
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          progress.status = error._tag === "ConnectionTransientError" ? "unreachable" : "failed";
          progress.error = error.message;
        }),
      ),
    );
    progress.route = {
      id: connectionRouteId(opened.route.target),
      kind: connectionRouteKind(opened.route),
    };
    const cached = yield* (
      cache.loadShellWithoutHydration?.(environmentId) ?? cache.loadShell(environmentId)
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read the cached shell before a background save.").pipe(
          Effect.annotateLogs({ environmentId, error: error.message }),
          Effect.as(Option.none<DeferredShellSnapshot>()),
        ),
      ),
    );
    const shell = yield* completeShellSnapshot(opened.value, Option.getOrNull(cached));
    const shellToPersist =
      cachedSequenceOf(cached) === shell.snapshotSequence && Option.isSome(cached)
        ? mergeEqualSequenceShellSnapshot(cached.value, shell)
        : shell;
    yield* saveIfNewer(
      shellToPersist.snapshotSequence,
      cachedSequenceOf(cached),
      cache.saveShellIfNewer?.(environmentId, shellToPersist) ??
        (cachedSequenceOf(cached) === shellToPersist.snapshotSequence
          ? Effect.succeed(false)
          : cache.saveShell(environmentId, shellToPersist).pipe(Effect.as(true))),
      (result) => {
        progress.shell = result;
      },
    );
    const stale = yield* Effect.filter(
      recentSettledThreads(shell, limit).filter((row) => !priority.includes(row.id)),
      (row) =>
        loadCachedThread(environmentId, row.id).pipe(
          Effect.map((cachedThread) => isThreadDetailStale(row, cachedThread)),
        ),
    );
    const selected = [...new Set(priority), ...stale.map((row) => row.id)];
    for (const threadId of selected) progress.threads.set(threadId, { _tag: "not-reached" });
    yield* Effect.forEach(
      selected,
      (threadId) =>
        syncThread(environmentId, opened.endpoint, threadId, (result) => {
          progress.threads.set(threadId, result);
        }),
      { concurrency: THREAD_FETCH_CONCURRENCY, discard: true },
    );
    progress.status = "synced";
  });

  const runOnce = Effect.fnUntraced(function* (request: BackgroundSyncRequest) {
    const startedAt = yield* Clock.currentTimeMillis;
    const finish = (
      outcome: BackgroundSyncReport["outcome"],
      progress: ReadonlyMap<EnvironmentId, EnvironmentProgress>,
      error: string | null,
    ) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now): BackgroundSyncReport => ({
          outcome,
          durationMs: now - startedAt,
          error,
          environments: [...progress].map(([environmentId, value]) => ({
            environmentId,
            status: value.status,
            route: value.route,
            shell: value.shell,
            threads: [...value.threads].map(([threadId, result]) => ({ threadId, result })),
            error: value.error,
          })),
        })),
      );

    const catalog = yield* loadPersistedCatalogEntries().pipe(Effect.result);
    if (catalog._tag === "Failure") {
      return yield* finish("failed", new Map(), catalog.failure.message);
    }
    const entries = [...catalog.success.values()].filter(
      (entry) => entry.enabled && entry.unsupportedReason === undefined,
    );
    const progress = new Map<EnvironmentId, EnvironmentProgress>(
      entries.map((entry) => [
        entry.target.environmentId,
        { status: "stopped", route: null, shell: null, threads: new Map(), error: null },
      ]),
    );
    const requestedLimit = request.maxThreadsPerEnvironment ?? DEFAULT_MAX_THREADS_PER_ENVIRONMENT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(0, Math.floor(requestedLimit))
      : DEFAULT_MAX_THREADS_PER_ENVIRONMENT;
    const work = Effect.forEach(
      entries,
      (entry) => {
        const environmentId = entry.target.environmentId;
        const environmentProgress = progress.get(environmentId)!;
        const priority = [
          ...new Set(
            (request.priorityThreads ?? [])
              .filter((ref) => ref.environmentId === environmentId)
              .map((ref) => ref.threadId),
          ),
        ].slice(0, MAX_PRIORITY_THREADS_PER_ENVIRONMENT);
        return syncEnvironment(entry, environmentProgress, priority, limit).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (Cause.hasInterruptsOnly(cause) || environmentProgress.status === "unreachable")
                return;
              environmentProgress.status = "failed";
              environmentProgress.error = Cause.pretty(cause);
            }),
          ),
        );
      },
      { concurrency: 1, discard: true },
    );
    const stopped =
      request.signal === undefined
        ? Effect.never
        : abortion(request.signal).pipe(Effect.as("cancelled" as const));
    const outcome = yield* work.pipe(
      Effect.as("completed" as const),
      Effect.timeoutOrElse({
        duration: request.budgetMs,
        orElse: () => Effect.succeed("deadline" as const),
      }),
      Effect.raceFirst(stopped),
    );
    return yield* finish(outcome, progress, null);
  });

  const run = (request: BackgroundSyncRequest) =>
    runOnce(request).pipe(provideDependencies, Effect.withSpan("BackgroundSync.run"));

  return BackgroundSync.of({ run });
});

export const layer = Layer.effect(BackgroundSync, make);
