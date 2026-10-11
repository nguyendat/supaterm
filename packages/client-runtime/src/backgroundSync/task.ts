import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as BackgroundSync from "./backgroundSync.ts";

/**
 * The seam between operating-system background work and BackgroundSync. iOS
 * BGAppRefreshTask and BGProcessingTask, Android WorkManager, and a silent
 * notification each hand JavaScript a time budget and an expiration callback,
 * and expect one completion report. A native caller maps its task to a
 * BackgroundSyncTask, aborts `signal` from its expiration handler, and reports
 * `completion` back to its scheduler.
 */
export interface BackgroundSyncTask {
  readonly trigger: "app-refresh" | "processing" | "notification" | "manual";
  /** Time the platform allows before it expires the task. */
  readonly platformBudgetMs: number;
  readonly signal?: AbortSignal;
  readonly priorityThreads?: ReadonlyArray<BackgroundSync.BackgroundSyncThreadRef>;
}

/**
 * iOS: `setTaskCompleted(success: completion !== "failed")`.
 * Android: `failed` maps to `Result.retry()`, otherwise `Result.success()`.
 */
export type BackgroundSyncCompletion = "new-data" | "no-data" | "failed";

export interface BackgroundSyncTaskResult {
  readonly completion: BackgroundSyncCompletion;
  readonly report: BackgroundSync.BackgroundSyncReport;
}

/** Kept back from the platform budget so in-flight writes and the completion call finish in time. */
export const COMPLETION_RESERVE_MS = 3_000;

export function syncBudgetMs(platformBudgetMs: number): number {
  return Math.max(0, platformBudgetMs - COMPLETION_RESERVE_MS);
}

export function completionFor(
  report: BackgroundSync.BackgroundSyncReport,
): BackgroundSyncCompletion {
  if (report.outcome === "failed") return "failed";
  if (report.environments.some((environment) => environment.status === "failed")) {
    return "failed";
  }
  const wrote = report.environments.some(
    (environment) =>
      environment.shell?._tag === "saved" ||
      environment.threads.some(
        ({ result }) => result._tag === "saved" || result._tag === "removed",
      ),
  );
  if (wrote) return "new-data";
  const reachedAny = report.environments.some((environment) => environment.shell !== null);
  return report.environments.length > 0 && !reachedAny ? "failed" : "no-data";
}

export const runTask = Effect.fn("BackgroundSyncTask.run")(function* (task: BackgroundSyncTask) {
  yield* Effect.annotateCurrentSpan({ "backgroundSync.trigger": task.trigger });
  const sync = yield* BackgroundSync.BackgroundSync;
  const report = yield* sync.run({
    budgetMs: syncBudgetMs(task.platformBudgetMs),
    ...(task.signal === undefined ? {} : { signal: task.signal }),
    ...(task.priorityThreads === undefined ? {} : { priorityThreads: task.priorityThreads }),
  });
  return { completion: completionFor(report), report } satisfies BackgroundSyncTaskResult;
});

/**
 * Returns the function a platform task calls. Each task gets its own runtime
 * built from `layer`, so the saved connection catalog is read fresh and
 * nothing the sync opened outlives the task. One task runs at a time; an
 * overlapping call reports `busy` without syncing.
 */
export function makeTaskRunner<E>(
  layer: Layer.Layer<BackgroundSync.BackgroundSync, E>,
): (task: BackgroundSyncTask) => Promise<BackgroundSyncTaskResult> {
  let running = false;
  return async (task) => {
    if (running) {
      return {
        completion: "no-data",
        report: { outcome: "busy", durationMs: 0, environments: [], error: null },
      };
    }
    running = true;
    const runtime = ManagedRuntime.make(layer);
    try {
      const exit = await runtime.runPromiseExit(runTask(task));
      if (Exit.isSuccess(exit)) return exit.value;
      return {
        completion: "failed",
        report: {
          outcome: "failed",
          durationMs: 0,
          environments: [],
          error: Cause.pretty(exit.cause),
        },
      };
    } finally {
      await runtime.dispose();
      running = false;
    }
  };
}
