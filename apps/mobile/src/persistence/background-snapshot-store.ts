import {
  SnapshotSyncPersistence,
  SnapshotSyncPersistenceError,
  layer as snapshotSyncStoreLayer,
} from "@supacode/client-runtime/background-sync";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MobileDatabase from "./mobile-database";

export const make = Effect.gen(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  return SnapshotSyncPersistence.of({
    read: (key) =>
      database
        .loadCache(key.environmentId, key.kind, key.cacheKey)
        .pipe(
          Effect.mapError(
            (cause) => new SnapshotSyncPersistenceError({ operation: "load", cause }),
          ),
        ),
    writeIfNewer: (key, _sequence, payload) =>
      database
        .saveCacheIfNewer(key.environmentId, key.kind, key.cacheKey, 1, payload)
        .pipe(
          Effect.mapError(
            (cause) => new SnapshotSyncPersistenceError({ operation: "save", cause }),
          ),
        ),
  });
});

const persistenceLayer = Layer.effect(SnapshotSyncPersistence, make).pipe(
  Layer.provide(MobileDatabase.isolatedLayer),
);
export const layer = snapshotSyncStoreLayer.pipe(Layer.provide(persistenceLayer));
