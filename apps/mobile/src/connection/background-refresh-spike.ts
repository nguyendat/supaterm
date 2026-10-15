import {
  ConnectionDriver,
  EnvironmentRegistry,
  connectionRoutes,
  type PreparedConnection,
} from "@supaterm/client-runtime/connection";
import { Persistence } from "@supaterm/client-runtime/platform";
import { ShellSnapshotLoader } from "@supaterm/client-runtime/state/shell";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { AppState } from "react-native";

import { appAtomRegistry } from "../state/atom-registry";
import { connectionAtomRuntime } from "./runtime";

export const BACKGROUND_REFRESH_SPIKE_TASK = "supaterm-background-refresh-spike";

const reactMounted = { value: false };

export function markReactMounted() {
  reactMounted.value = true;
}

type Mark = (event: string, detail?: Record<string, unknown>) => void;

function makeTimeline(): Mark {
  const startedAt = Date.now();
  return (event, detail = {}) => {
    const entry = {
      t: Date.now() - startedAt,
      event,
      appState: AppState.currentState,
      reactMounted: reactMounted.value,
      ...detail,
    };
    console.log(`[bgspike] ${JSON.stringify(entry)}`);
  };
}

const refreshShells = (mark: Mark) =>
  Effect.gen(function* () {
    mark("runtime-ready");
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const driver = yield* ConnectionDriver;
    const loader = yield* ShellSnapshotLoader.ShellSnapshotLoader;
    const cache = yield* Persistence.EnvironmentCacheStore;
    const entries = yield* SubscriptionRef.get(registry.entries);
    mark("catalog-read", { environments: entries.size });

    for (const environmentId of entries.keys()) {
      yield* registry.stateChanges(environmentId).pipe(
        Stream.runForEach((state) =>
          Effect.sync(() =>
            mark("supervisor", {
              environmentId,
              phase: state.phase,
              stage: state.stage,
              desired: state.desired,
            }),
          ),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
    }

    yield* Effect.forEach(
      entries,
      ([environmentId, entry]) =>
        Effect.gen(function* () {
          let prepared = Option.none<{ readonly prepared: PreparedConnection }>();
          for (const route of connectionRoutes(entry)) {
            const result = yield* driver.preflight(entry, route);
            mark("preflight", {
              environmentId,
              route: route.target.label,
              kind: route.target._tag,
              ok: Option.isSome(result),
            });
            if (Option.isSome(result)) {
              prepared = result;
              break;
            }
          }
          if (Option.isNone(prepared)) return;
          const shell = yield* loader.load(prepared.value.prepared);
          if (Option.isNone(shell)) {
            mark("shell-failed", { environmentId });
            return;
          }
          const { loadPullRequests, ...snapshot } = shell.value;
          mark("shell-fetched", {
            environmentId,
            threads: snapshot.threads.length,
            archivedThreads: snapshot.archivedThreads.length,
            projects: snapshot.projects.length,
            sequence: snapshot.snapshotSequence,
          });
          if (loadPullRequests) {
            const links = yield* loadPullRequests;
            mark("pr-links-decoded", { environmentId, threadsWithLinks: links.size });
          }
          yield* cache.saveShell(environmentId, snapshot).pipe(
            Effect.tap(() => Effect.sync(() => mark("shell-saved", { environmentId }))),
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                mark("shell-save-failed", { environmentId, cause: Cause.pretty(cause) }),
              ),
            ),
          );
        }),
      { concurrency: "unbounded", discard: true },
    );
    yield* Effect.sleep("3 seconds");
    mark("done");
  }).pipe(Effect.scoped);

async function runSpike(trigger: string) {
  const mark = makeTimeline();
  mark("task-start", { trigger });
  const atom = connectionAtomRuntime.atom(
    refreshShells(mark).pipe(
      Effect.timeout("25 seconds"),
      Effect.catchCause((cause) =>
        Effect.sync(() => mark("error", { cause: Cause.pretty(cause) })),
      ),
    ),
  );
  await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => mark("runtime-error", { cause: Cause.pretty(cause) })),
      ),
    ),
  );
  mark("task-end");
}

TaskManager.defineTask(BACKGROUND_REFRESH_SPIKE_TASK, async () => {
  await runSpike("os");
  return BackgroundTask.BackgroundTaskResult.Success;
});

export async function registerBackgroundRefreshSpike() {
  const status = await BackgroundTask.getStatusAsync();
  console.log(`[bgspike] status ${status}`);
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
  await BackgroundTask.registerTaskAsync(BACKGROUND_REFRESH_SPIKE_TASK, { minimumInterval: 15 });
  console.log("[bgspike] registered");
}
