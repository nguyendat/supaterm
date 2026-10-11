import {
  BackgroundSnapshot,
  BackgroundSnapshotStore,
  BackgroundSyncPersistenceError,
} from "@supacode/client-runtime/background-sync";
import { type EnvironmentId } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SQLiteDatabase } from "expo-sqlite";

const StoredSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  record: BackgroundSnapshot,
});
const codec = Schema.fromJsonString(Schema.toCodecJson(StoredSnapshot));
const failure = (cause: unknown) => new BackgroundSyncPersistenceError({ cause });

export const make = Effect.fn("MobileBackgroundSyncStore.make")(function* (
  database: Pick<SQLiteDatabase, "execSync" | "runSync" | "getFirstSync">,
) {
  yield* Effect.try({
    try: () =>
      database.execSync(`
      CREATE TABLE IF NOT EXISTS background_snapshot (
        environment_id TEXT NOT NULL,
        snapshot_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (environment_id, snapshot_key)
      ) WITHOUT ROWID
    `),
    catch: failure,
  });
  const save = Effect.fn("MobileBackgroundSyncStore.save")(function* (
    environmentId: EnvironmentId,
    record: BackgroundSnapshot,
  ) {
    const payload = yield* Schema.encodeEffect(codec)({ schemaVersion: 1, record }).pipe(
      Effect.mapError(failure),
    );
    const key =
      record.kind === "shell" ? "shell" : `thread:${record.snapshot.projection.thread.id}`;
    return yield* Effect.try({
      try: () =>
        database.runSync(
          `
        INSERT INTO background_snapshot (environment_id, snapshot_key, sequence, payload)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (environment_id, snapshot_key) DO UPDATE SET
          sequence = excluded.sequence, payload = excluded.payload
        WHERE excluded.sequence > background_snapshot.sequence
      `,
          environmentId,
          key,
          record.snapshot.snapshotSequence,
          payload,
        ).changes > 0,
      catch: failure,
    });
  });
  const load = Effect.fn("MobileBackgroundSyncStore.load")(function* (
    environmentId: EnvironmentId,
    key: string,
  ) {
    const row = yield* Effect.try({
      try: () =>
        database.getFirstSync<{ readonly payload: string }>(
          "SELECT payload FROM background_snapshot WHERE environment_id = ? AND snapshot_key = ?",
          environmentId,
          key,
        ),
      catch: failure,
    });
    return row === null
      ? Option.none()
      : Option.some(
          (yield* Schema.decodeEffect(codec)(row.payload).pipe(Effect.mapError(failure))).record,
        );
  });
  return { save, load };
});

export const layer = Layer.effect(
  BackgroundSnapshotStore,
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const SQLite = await import("expo-sqlite");
          return SQLite.openDatabaseSync("supacode-background-sync.db");
        },
        catch: failure,
      }),
      (database) => Effect.sync(() => database.closeSync()),
    );
    return yield* make(database);
  }),
);
