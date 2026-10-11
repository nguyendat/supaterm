import {
  BackgroundSyncInputError,
  validateSyncLimits,
  syncEnvironmentOnce,
  type BackgroundSyncResult,
} from "@supacode/client-runtime/background-sync";
import { CredentialStore } from "@supacode/client-runtime/connection";
import { layerRemoteHttpClient } from "@supacode/client-runtime/rpc";
import type { EnvironmentId, ThreadId } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BackgroundSnapshotStore from "../persistence/background-snapshot-store";
import * as CatalogStore from "./catalog-store";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

export interface MobileBackgroundSyncInput {
  readonly environmentId: EnvironmentId;
  readonly deadlineMs?: number;
  readonly maxThreads?: number;
  readonly threadIds?: ReadonlyArray<ThreadId>;
  readonly signal?: AbortSignal;
}

export const mobileBackgroundSyncOnce = Effect.fn("mobileBackgroundSyncOnce")(function* (
  input: MobileBackgroundSyncInput,
) {
  let progress: BackgroundSyncResult = {
    environmentId: input.environmentId,
    status: "completed",
    routeId: null,
    shell: null,
    threads: [],
  };
  const program = Effect.gen(function* () {
    const catalog = yield* CatalogStore.make();
    const document = yield* catalog.read;
    const target = document.targets.find(
      (candidate) => candidate.environmentId === input.environmentId,
    );
    if (target === undefined)
      return yield* new BackgroundSyncInputError({
        message: "The environment is not saved on this device.",
      });
    const routeFor = (candidate: typeof target) => ({
      target: candidate,
      profile: Option.fromUndefinedOr(
        document.profiles.find((profile) => profile.connectionId === candidate.connectionId),
      ),
    });
    const alternates = document.targets.filter(
      (candidate) =>
        candidate.environmentId === input.environmentId &&
        candidate.connectionId !== target.connectionId,
    );
    const credentials = CredentialStore.make({
      get: (connectionId) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            document.credentials.find((credential) => credential.connectionId === connectionId)
              ?.credential,
          ),
        ),
      put: () => Effect.void,
      remove: () => Effect.void,
    });
    return yield* syncEnvironmentOnce(
      {
        ...input,
        entry: {
          ...routeFor(target),
          alternateRoutes: alternates.map(routeFor),
          enabled: !document.disabledEnvironmentIds.includes(input.environmentId),
        },
      },
      (result) => {
        progress = result;
      },
    ).pipe(Effect.provideService(CredentialStore.ConnectionCredentialStore, credentials));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BackgroundSnapshotStore.layer,
        MobileSecureStorage.layer,
        layerRemoteHttpClient(globalThis.fetch),
      ),
    ),
    Effect.scoped,
  );
  const limits = yield* validateSyncLimits(input);
  return yield* program.pipe(
    Effect.timeoutOrElse({
      duration: limits.deadlineMs,
      orElse: () => Effect.succeed({ ...progress, status: "deadline-exceeded" as const }),
    }),
  );
});

export function runMobileBackgroundSyncOnce(
  input: MobileBackgroundSyncInput,
): Promise<BackgroundSyncResult> {
  return Effect.runPromise(mobileBackgroundSyncOnce(input), { signal: input.signal });
}
