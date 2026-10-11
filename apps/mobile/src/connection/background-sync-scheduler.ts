import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import {
  connectionRouteId,
  credentialConnectionId,
  connectionRoutes,
  loadPersistedCatalogEntries,
  CredentialStore,
} from "@supacode/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";

import { runMobileBackgroundSync } from "./background-sync";
import * as Runtime from "../lib/runtime";
import * as ConnectionStorage from "./storage";

export const MOBILE_BACKGROUND_SYNC_TASK = "supacode-background-sync";
export const MOBILE_BACKGROUND_SYNC_INTERVAL_MINUTES = 15;
const PLATFORM_BUDGET_MS = 30_000;

let activeController: AbortController | null = null;

export function cancelMobileBackgroundSync(): void {
  activeController?.abort();
}

TaskManager.defineTask(MOBILE_BACKGROUND_SYNC_TASK, async () => {
  if (activeController !== null) return BackgroundTask.BackgroundTaskResult.Success;
  const controller = new AbortController();
  activeController = controller;
  try {
    const result = await runMobileBackgroundSync({
      trigger: "processing",
      platformBudgetMs: PLATFORM_BUDGET_MS,
      signal: controller.signal,
    });
    return result.completion === "failed"
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  } finally {
    if (activeController === controller) activeController = null;
  }
});

try {
  BackgroundTask.addExpirationListener(() => activeController?.abort());
} catch {
  activeController = null;
}

async function reconcileMobileBackgroundSync(): Promise<boolean> {
  if ((await BackgroundTask.getStatusAsync()) === BackgroundTask.BackgroundTaskStatus.Restricted) {
    return false;
  }
  const catalogRuntime = ManagedRuntime.make(
    ConnectionStorage.layer.pipe(Layer.provide(Runtime.layer)),
  );
  let hasEligibleEnvironment: boolean | undefined;
  try {
    hasEligibleEnvironment = await catalogRuntime.runPromise(
      Effect.gen(function* () {
        const credentials = yield* CredentialStore.ConnectionCredentialStore;
        const entries = yield* loadPersistedCatalogEntries();
        const eligible = [...entries.values()].filter(
          (entry) => entry.enabled && entry.unsupportedReason === undefined,
        );
        const readable = yield* Effect.forEach(eligible, (entry) =>
          Effect.forEach(
            connectionRoutes(entry).filter(
              (route) =>
                route.target._tag === "BearerConnectionTarget" &&
                Option.isSome(route.profile) &&
                route.profile.value._tag === "BearerConnectionProfile",
            ),
            (route) =>
              credentials
                .get(credentialConnectionId(connectionRouteId(route.target)))
                .pipe(Effect.map((value) => Option.isSome(value))),
          ).pipe(Effect.map((routes) => routes.some(Boolean))),
        );
        return readable.some(Boolean);
      }),
    );
  } catch {
    hasEligibleEnvironment = undefined;
  }
  await catalogRuntime.dispose();
  const registered = await TaskManager.isTaskRegisteredAsync(MOBILE_BACKGROUND_SYNC_TASK);
  if (hasEligibleEnvironment === undefined) return registered;
  if (!hasEligibleEnvironment) {
    if (registered) await BackgroundTask.unregisterTaskAsync(MOBILE_BACKGROUND_SYNC_TASK);
    return false;
  }
  if (!registered) {
    await BackgroundTask.registerTaskAsync(MOBILE_BACKGROUND_SYNC_TASK, {
      minimumInterval: MOBILE_BACKGROUND_SYNC_INTERVAL_MINUTES,
    });
  }
  return true;
}

let registrationQueue = Promise.resolve(false);

export function registerMobileBackgroundSync(): Promise<boolean> {
  registrationQueue = registrationQueue.then(
    reconcileMobileBackgroundSync,
    reconcileMobileBackgroundSync,
  );
  return registrationQueue;
}
