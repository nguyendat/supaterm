import {
  type EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  type ThreadId,
} from "@supacode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import { withHttpRoute } from "../connection/httpLease.ts";
import { ConnectionTransientError } from "../connection/model.ts";
import { connectionRouteId } from "../connection/routes.ts";
import { fetchEnvironmentShellSnapshot } from "../state/shellSnapshotHttp.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "../state/boundedThreadSnapshotHttp.ts";

export const BackgroundSnapshot = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("shell"), snapshot: OrchestrationV2ShellSnapshot }),
  Schema.Struct({ kind: Schema.Literal("thread"), snapshot: OrchestrationV2ThreadBoundedSnapshot }),
]);
export type BackgroundSnapshot = typeof BackgroundSnapshot.Type;

export class BackgroundSyncPersistenceError extends Schema.TaggedError<BackgroundSyncPersistenceError>()(
  "BackgroundSyncPersistenceError",
  { cause: Schema.Defect() },
) {}

export class BackgroundSnapshotStore extends Context.Service<
  BackgroundSnapshotStore,
  {
    readonly save: (
      environmentId: EnvironmentId,
      record: BackgroundSnapshot,
    ) => Effect.Effect<boolean, BackgroundSyncPersistenceError>;
  }
>()("@supacode/client-runtime/background/sync/BackgroundSnapshotStore") {}

export interface BackgroundSyncInput {
  readonly entry: ConnectionCatalogEntry;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly budgetMs?: number;
}

export const MAX_BACKGROUND_SYNC_THREADS = 5;
export const MAX_BACKGROUND_SYNC_BUDGET_MS = 30_000;

export function backgroundSyncBudget(budgetMs?: number) {
  const totalMs =
    budgetMs !== undefined && Number.isFinite(budgetMs)
      ? Math.max(1, Math.min(budgetMs, MAX_BACKGROUND_SYNC_BUDGET_MS))
      : 20_000;
  const cleanupMs = Math.min(1_000, totalMs / 4);
  return { workMs: totalMs - cleanupMs, cleanupMs };
}

export const syncOnce = Effect.fn("BackgroundSync.syncOnce")(function* (
  input: BackgroundSyncInput,
) {
  const budget = backgroundSyncBudget(input.budgetMs);
  const selected = [...new Set(input.threadIds)];
  const threadIds = selected.slice(0, MAX_BACKGROUND_SYNC_THREADS);
  return yield* Effect.gen(function* () {
    const store = yield* BackgroundSnapshotStore;
    const batch = yield* withHttpRoute(
      input.entry,
      (prepared) =>
        Effect.gen(function* () {
          const shell = yield* fetchEnvironmentShellSnapshot({ prepared, timeoutMs: 4_000 });
          const threads = yield* Effect.forEach(
            threadIds,
            (threadId) =>
              fetchEnvironmentBoundedThreadSnapshot({ prepared, threadId, timeoutMs: 4_000 }).pipe(
                Effect.asSome,
                Effect.catchTags({ EnvironmentResourceNotFoundError: () => Effect.succeedNone }),
              ),
            { concurrency: 2 },
          );
          return { routeId: connectionRouteId(prepared.target), shell, threads };
        }).pipe(Effect.mapError(mapRemoteEnvironmentError)),
      budget.cleanupMs,
    );
    const shellSaved = yield* store.save(input.entry.target.environmentId, {
      kind: "shell",
      snapshot: batch.shell,
    });
    const threads = yield* Effect.forEach(batch.threads, (snapshot, index) =>
      Effect.gen(function* () {
        const threadId = threadIds[index]!;
        if (Option.isNone(snapshot)) return { threadId, status: "missing" as const };
        const saved = yield* store.save(input.entry.target.environmentId, {
          kind: "thread",
          snapshot: snapshot.value,
        });
        return {
          threadId,
          status: saved ? ("saved" as const) : ("stale" as const),
          snapshotSequence: snapshot.value.snapshotSequence,
        };
      }),
    );
    return {
      environmentId: input.entry.target.environmentId,
      routeId: batch.routeId,
      shell: {
        status: shellSaved ? ("saved" as const) : ("stale" as const),
        snapshotSequence: batch.shell.snapshotSequence,
      },
      threads,
      omittedThreadCount: selected.length - threadIds.length,
    };
  }).pipe(
    Effect.timeoutOrElse({
      duration: budget.workMs,
      orElse: () =>
        Effect.fail(
          new ConnectionTransientError({
            reason: "timeout",
            detail: "Background sync exhausted its deadline.",
          }),
        ),
    }),
  );
});
