import type { EnvironmentId } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Persistence from "../platform/persistence.ts";
import type { ConnectionProfile, ConnectionRoute } from "./catalog.ts";
import type { ConnectionTarget } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import { connectionRouteId, entryWithRoutes } from "./routes.ts";

/**
 * Saved environments with their routes in fallback order. The registry seeds
 * itself from this, and headless work such as background sync reads the same
 * catalog without starting any connection.
 */
export const loadPersistedCatalogEntries = Effect.fn("loadPersistedCatalogEntries")(function* () {
  const storage = yield* Persistence.ConnectionTargetStore;
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const persistedTargets = yield* storage.list;
  const disabledEnvironmentIds = new Set(yield* storage.listDisabled);
  const loadRoute = Effect.fn("loadPersistedCatalogEntries.loadRoute")(function* (
    target: ConnectionTarget,
  ) {
    const profile: Option.Option<ConnectionProfile> =
      target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
        ? yield* profiles.get(target.connectionId)
        : Option.none();
    return { target, profile } satisfies ConnectionRoute;
  });
  const persistedRoutesByEnvironment = new Map<EnvironmentId, Array<ConnectionTarget>>();
  for (const target of persistedTargets) {
    const routes = persistedRoutesByEnvironment.get(target.environmentId) ?? [];
    routes.push(target);
    persistedRoutesByEnvironment.set(target.environmentId, routes);
  }
  return new Map(
    yield* Effect.forEach(
      persistedRoutesByEnvironment,
      Effect.fn("loadPersistedCatalogEntries.loadEntry")(function* ([environmentId, targets]) {
        const loaded = yield* Effect.forEach(targets, loadRoute, { concurrency: 2 });
        const seen = new Set<string>();
        const usable = loaded.filter((route) => {
          const id = connectionRouteId(route.target);
          if (seen.has(id)) return false;
          seen.add(id);
          return !(id.startsWith("learned:") && Option.isNone(route.profile));
        });
        const routes = usable.length > 0 ? usable : loaded.slice(0, 1);
        const first = routes[0]!;
        return [
          environmentId,
          entryWithRoutes(
            {
              target: first.target,
              profile: first.profile,
              enabled: !disabledEnvironmentIds.has(environmentId),
            },
            routes,
          ),
        ] as const;
      }),
      { concurrency: 2 },
    ),
  );
});
