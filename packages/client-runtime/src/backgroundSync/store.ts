import {
  EnvironmentId,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@supacode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
} from "../platform/orchestrationCache.ts";
import type { OrchestrationV2ShellSnapshot } from "@supacode/contracts";

export class SnapshotSyncPersistenceError extends Schema.TaggedError<SnapshotSyncPersistenceError>()(
  "SnapshotSyncPersistenceError",
  { operation: Schema.Literals(["load", "save"]), cause: Schema.Defect() },
) {}

export interface SnapshotSyncKey {
  readonly environmentId: EnvironmentId;
  readonly kind: "background-shell" | "background-thread";
  readonly cacheKey: string;
}

export class SnapshotSyncPersistence extends Context.Service<
  SnapshotSyncPersistence,
  {
    readonly read: (
      key: SnapshotSyncKey,
    ) => Effect.Effect<Option.Option<string>, SnapshotSyncPersistenceError>;
    readonly writeIfNewer: (
      key: SnapshotSyncKey,
      sequence: number,
      payload: string,
    ) => Effect.Effect<boolean, SnapshotSyncPersistenceError>;
  }
>()("@supacode/client-runtime/backgroundSync/store/SnapshotSyncPersistence") {}

const StoredBoundedThreadSnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationV2ThreadBoundedSnapshot.mapFields((fields) => ({
    ...fields,
    projection: OrchestrationV2ThreadProjectionJson,
  })),
});

const shellCodec = Schema.fromJsonString(StoredOrchestrationShellSnapshot);
const threadCodec = Schema.fromJsonString(StoredBoundedThreadSnapshot);
const encodeShell = Schema.encodeEffect(shellCodec);
const decodeShell = Schema.decodeUnknownEffect(shellCodec);
const encodeThread = Schema.encodeEffect(threadCodec);
const decodeThread = Schema.decodeUnknownEffect(threadCodec);

const shellKey = (environmentId: EnvironmentId): SnapshotSyncKey => ({
  environmentId,
  kind: "background-shell",
  cacheKey: "snapshot",
});
const threadKey = (environmentId: EnvironmentId, threadId: ThreadId): SnapshotSyncKey => ({
  environmentId,
  kind: "background-thread",
  cacheKey: threadId,
});
const codecError = (operation: "load" | "save") => (cause: unknown) =>
  new SnapshotSyncPersistenceError({ operation, cause });

export class SnapshotSyncStore extends Context.Service<
  SnapshotSyncStore,
  {
    readonly saveShell: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationV2ShellSnapshot,
    ) => Effect.Effect<boolean, SnapshotSyncPersistenceError>;
    readonly saveThread: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationV2ThreadBoundedSnapshot,
    ) => Effect.Effect<boolean, SnapshotSyncPersistenceError>;
    readonly loadShell: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<OrchestrationV2ShellSnapshot>, SnapshotSyncPersistenceError>;
    readonly loadThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<OrchestrationV2ThreadBoundedSnapshot>,
      SnapshotSyncPersistenceError
    >;
  }
>()("@supacode/client-runtime/backgroundSync/store/SnapshotSyncStore") {}

export const make = Effect.gen(function* () {
  const persistence = yield* SnapshotSyncPersistence;
  return SnapshotSyncStore.of({
    saveShell: Effect.fn("SnapshotSyncStore.saveShell")(function* (environmentId, snapshot) {
      const payload = yield* encodeShell({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot,
      }).pipe(Effect.mapError(codecError("save")));
      return yield* persistence.writeIfNewer(
        shellKey(environmentId),
        snapshot.snapshotSequence,
        payload,
      );
    }),
    saveThread: Effect.fn("SnapshotSyncStore.saveThread")(function* (environmentId, snapshot) {
      const threadId = snapshot.projection.thread.id;
      const payload = yield* encodeThread({ environmentId, threadId, snapshot }).pipe(
        Effect.mapError(codecError("save")),
      );
      return yield* persistence.writeIfNewer(
        threadKey(environmentId, threadId),
        snapshot.snapshotSequence,
        payload,
      );
    }),
    loadShell: Effect.fn("SnapshotSyncStore.loadShell")(function* (environmentId) {
      const raw = yield* persistence.read(shellKey(environmentId));
      if (Option.isNone(raw)) return Option.none();
      const stored = yield* decodeShell(raw.value).pipe(Effect.mapError(codecError("load")));
      if (stored.environmentId !== environmentId) {
        return yield* new SnapshotSyncPersistenceError({
          operation: "load",
          cause: "Environment mismatch",
        });
      }
      return Option.some(stored.snapshot);
    }),
    loadThread: Effect.fn("SnapshotSyncStore.loadThread")(function* (environmentId, threadId) {
      const raw = yield* persistence.read(threadKey(environmentId, threadId));
      if (Option.isNone(raw)) return Option.none();
      const stored = yield* decodeThread(raw.value).pipe(Effect.mapError(codecError("load")));
      if (
        stored.environmentId !== environmentId ||
        stored.threadId !== threadId ||
        stored.snapshot.projection.thread.id !== threadId
      ) {
        return yield* new SnapshotSyncPersistenceError({
          operation: "load",
          cause: "Thread identity mismatch",
        });
      }
      return Option.some(stored.snapshot);
    }),
  });
});

export const layer = Layer.effect(SnapshotSyncStore, make);
