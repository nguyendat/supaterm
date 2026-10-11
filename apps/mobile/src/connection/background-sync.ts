import { syncOnce, backgroundSyncBudget } from "@supacode/client-runtime/background-sync";
import {
  CredentialStore,
  ConnectionBlockedError,
  ConnectionTransientError,
  entryWithRoutes,
} from "@supacode/client-runtime/connection";
import { type EnvironmentId, type ThreadId } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Runtime from "../lib/runtime";
import * as CatalogStore from "./catalog-store";
import * as SnapshotStore from "./background-sync-store";

export interface MobileBackgroundSyncInput {
  readonly environmentId: EnvironmentId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
}

export const syncMobileEnvironmentOnce = Effect.fn("MobileBackgroundSync.syncOnce")(function* (
  input: MobileBackgroundSyncInput,
) {
  const catalog = yield* CatalogStore.make();
  const document = yield* catalog.read;
  const routes = document.targets
    .filter((target) => target.environmentId === input.environmentId)
    .map((target) => ({
      target,
      profile: Option.fromUndefinedOr(
        document.profiles.find((profile) => profile.connectionId === target.connectionId),
      ),
    }));
  const first = routes[0];
  if (first === undefined) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "The environment is not paired.",
    });
  }
  const credentials = CredentialStore.make({
    get: (connectionId) =>
      Effect.succeed(
        Option.fromUndefinedOr(
          document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
        ),
      ),
    put: () => Effect.die("Background sync cannot change credentials."),
    remove: () => Effect.die("Background sync cannot remove credentials."),
  });
  return yield* syncOnce({
    entry: entryWithRoutes(
      { ...first, enabled: !document.disabledEnvironmentIds.includes(input.environmentId) },
      routes,
    ),
    threadIds: input.threadIds,
    ...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
  }).pipe(
    Effect.provideService(CredentialStore.ConnectionCredentialStore, credentials),
    Effect.provide(SnapshotStore.layer),
  );
});

export function runMobileBackgroundSync(input: MobileBackgroundSyncInput) {
  const budget = backgroundSyncBudget(input.budgetMs);
  return Effect.runPromise(
    syncMobileEnvironmentOnce(input).pipe(
      Effect.provide(Runtime.layer),
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
    ),
    input.signal === undefined ? undefined : { signal: input.signal },
  );
}
