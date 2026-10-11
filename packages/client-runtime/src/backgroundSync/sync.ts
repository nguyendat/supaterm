import type { EnvironmentId, OrchestrationV2ShellSnapshot, ThreadId } from "@supacode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ConnectionCatalogEntry, ConnectionRoute } from "../connection/catalog.ts";
import {
  checkConnectionRoute,
  connectOverRoutes,
  ROUTE_CHECK_TIMEOUT_MS,
} from "../connection/driver.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import { ConnectionBlockedError } from "../connection/model.ts";
import { prepareHttpConnection } from "../connection/resolver.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
  entryWithRoutes,
  insertRoute,
  routeEntry,
} from "../connection/routes.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "../state/boundedThreadSnapshotHttp.ts";
import { fetchEnvironmentShellSnapshot } from "../state/shellSnapshotHttp.ts";
import { SnapshotSyncStore } from "./store.ts";

const MAX_THREADS = 20;
export const DEFAULT_SYNC_DEADLINE_MS = 15_000;
const DEFAULT_THREADS = 5;

export interface BackgroundSyncInput {
  readonly entry: ConnectionCatalogEntry;
  readonly deadlineMs?: number;
  readonly maxThreads?: number;
  readonly threadIds?: ReadonlyArray<ThreadId>;
}

export interface BackgroundSyncResult {
  readonly environmentId: EnvironmentId;
  readonly status: "completed" | "partial" | "deadline-exceeded" | "disabled";
  readonly routeId: string | null;
  readonly shell: { readonly sequence: number; readonly stored: boolean } | null;
  readonly threads: ReadonlyArray<
    | {
        readonly threadId: ThreadId;
        readonly status: "synced";
        readonly sequence: number;
        readonly stored: boolean;
        readonly payloadBudgetExceeded: boolean;
      }
    | { readonly threadId: ThreadId; readonly status: "failed"; readonly reason: string }
  >;
}

export class BackgroundSyncInputError extends Schema.TaggedError<BackgroundSyncInputError>()(
  "BackgroundSyncInputError",
  { message: Schema.String },
) {}

const SyncLimits = Schema.Struct({
  deadlineMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 60_000 }),
  ),
  maxThreads: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: MAX_THREADS }),
  ),
});
const decodeLimits = Schema.decodeUnknownEffect(SyncLimits);

export const validateSyncLimits = Effect.fnUntraced(function* (input: {
  readonly deadlineMs?: number;
  readonly maxThreads?: number;
}) {
  return yield* decodeLimits({
    deadlineMs: input.deadlineMs ?? DEFAULT_SYNC_DEADLINE_MS,
    maxThreads: input.maxThreads ?? DEFAULT_THREADS,
  }).pipe(Effect.mapError((cause) => new BackgroundSyncInputError({ message: cause.message })));
});

function selectThreads(
  input: BackgroundSyncInput,
  shell: OrchestrationV2ShellSnapshot,
  limit: number,
) {
  const candidates =
    input.threadIds ??
    [...shell.threads]
      .sort((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
      .map((thread) => thread.id);
  return [...new Set(candidates)].slice(0, limit);
}

export const syncEnvironmentOnce = Effect.fn("backgroundSync.syncEnvironmentOnce")(function* (
  input: BackgroundSyncInput,
  reportProgress?: (result: BackgroundSyncResult) => void,
) {
  const limits = yield* validateSyncLimits(input);
  const result: BackgroundSyncResult = {
    environmentId: input.entry.target.environmentId,
    status: "completed",
    routeId: null,
    shell: null,
    threads: [],
  };
  if (!input.entry.enabled) return { ...result, status: "disabled" as const };
  let progress = result;
  const publishProgress = (next: BackgroundSyncResult) =>
    Effect.sync(() => {
      progress = next;
      reportProgress?.(next);
    });
  const run = Effect.gen(function* () {
    const store = yield* SnapshotSyncStore;
    let routes: ReadonlyArray<ConnectionRoute> = [];
    for (const route of connectionRoutes(input.entry)) {
      if (route.target._tag !== "BearerConnectionTarget" || connectionRouteKind(route) === "relay")
        continue;
      routes = insertRoute(routes, route);
    }
    if (routes.length === 0) {
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Background sync requires a direct HTTP bearer route.",
      });
    }
    const entry = entryWithRoutes(input.entry, routes);
    const { prepared, shell } = yield* connectOverRoutes(
      entry,
      (route) => checkConnectionRoute(entry, route, ROUTE_CHECK_TIMEOUT_MS),
      Effect.fnUntraced(function* (route) {
        const target = route.target;
        if (target._tag !== "BearerConnectionTarget") {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "Background sync requires a bearer route.",
          });
        }
        const prepared = yield* prepareHttpConnection({ ...routeEntry(entry, route), target });
        const deferred = yield* fetchEnvironmentShellSnapshot({ prepared }).pipe(
          Effect.mapError(mapRemoteEnvironmentError),
        );
        const links =
          deferred.loadPullRequests === undefined ? new Map() : yield* deferred.loadPullRequests;
        const { loadPullRequests: _load, ...snapshot } = deferred;
        const shell = {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            links.has(thread.id) ? { ...thread, pullRequests: links.get(thread.id)! } : thread,
          ),
        };
        return { prepared, shell };
      }),
      Math.min(3_000, limits.deadlineMs),
    );
    yield* publishProgress({ ...progress, routeId: connectionRouteId(prepared.target) });
    const stored = yield* store.saveShell(prepared.environmentId, shell);
    yield* publishProgress({ ...progress, shell: { sequence: shell.snapshotSequence, stored } });
    for (const threadId of selectThreads(input, shell, limits.maxThreads)) {
      const snapshot = yield* fetchEnvironmentBoundedThreadSnapshot({ prepared, threadId }).pipe(
        Effect.result,
      );
      if (snapshot._tag === "Failure") {
        yield* publishProgress({
          ...progress,
          status: "partial",
          threads: [
            ...progress.threads,
            { threadId, status: "failed", reason: snapshot.failure._tag },
          ],
        });
        continue;
      }
      if (snapshot.success.projection.thread.id !== threadId) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "The thread snapshot belongs to a different thread.",
        });
      }
      const stored = yield* store.saveThread(prepared.environmentId, snapshot.success);
      yield* publishProgress({
        ...progress,
        threads: [
          ...progress.threads,
          {
            threadId,
            status: "synced",
            sequence: snapshot.success.snapshotSequence,
            stored,
            payloadBudgetExceeded: snapshot.success.payloadBudgetExceeded ?? false,
          },
        ],
      });
    }
    return progress;
  });
  return yield* run.pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: limits.deadlineMs,
      orElse: () => Effect.succeed({ ...progress, status: "deadline-exceeded" as const }),
    }),
  );
});
