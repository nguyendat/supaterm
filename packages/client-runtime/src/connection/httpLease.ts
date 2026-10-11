import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { parseRelayAddress } from "@supacode/shared/relay/protocol";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import { checkConnectionRoute, connectOverRoutes, LATE_ROUTE_CHECK_TIMEOUT_MS } from "./driver.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type PreparedHttpConnection,
} from "./model.ts";
import { bearerRouteCredentials } from "./resolver.ts";
import { connectionRoutes, entryWithRoutes, insertRoute, routeEntry } from "./routes.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { RelayGateway, type RelayOriginLease } from "../relay/gateway.ts";

export const withHttpRoute = Effect.fn("Connection.withHttpRoute")(function* <A, R>(
  entry: ConnectionCatalogEntry,
  read: (prepared: PreparedHttpConnection) => Effect.Effect<A, ConnectionAttemptError, R>,
  cleanupMs: number,
) {
  if (!entry.enabled) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "The environment is switched off.",
    });
  }
  const gateway = yield* Effect.serviceOption(RelayGateway);
  return yield* Effect.acquireUseRelease(
    Effect.sync(
      () =>
        new Map<string, { readonly lease: RelayOriginLease; readonly origin: Promise<string> }>(),
    ),
    (leases) =>
      Effect.gen(function* () {
        const resolveOrigin = (address: string, relayUrl?: string) =>
          Effect.tryPromise({
            try: () => {
              if (parseRelayAddress(address) === null) return Promise.resolve(address);
              if (Option.isNone(gateway))
                return Promise.reject(new Error("Relay transport is unavailable."));
              const key = `${address}\n${relayUrl ?? ""}`;
              let owned = leases.get(key);
              if (owned === undefined) {
                const lease = gateway.value.lease(address, relayUrl);
                owned = { lease, origin: lease.prepare() };
                leases.set(key, owned);
              }
              return owned.origin;
            },
            catch: () =>
              new ConnectionTransientError({
                reason: "transport",
                detail: "The relay tunnel could not be opened.",
              }),
          });
        const prepare = Effect.fnUntraced(function* (route: ConnectionRoute) {
          const target = route.target;
          if (target._tag !== "BearerConnectionTarget") {
            return yield* new ConnectionBlockedError({
              reason: "configuration",
              detail: "Background sync requires a paired bearer connection.",
            });
          }
          if (target.environmentId !== entry.target.environmentId) {
            return yield* environmentMismatchError({
              expected: entry.target.environmentId,
              actual: target.environmentId,
            });
          }
          const { profile, credential } = yield* bearerRouteCredentials({
            ...routeEntry(entry, route),
            target,
          });
          const httpBaseUrl = yield* resolveOrigin(profile.httpBaseUrl, profile.relayUrl);
          const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
            Effect.mapError(mapRemoteEnvironmentError),
          );
          if (descriptor.environmentId !== target.environmentId) {
            return yield* environmentMismatchError({
              expected: target.environmentId,
              actual: descriptor.environmentId,
            });
          }
          const incompatible = orchestrationProtocolCompatibilityError(descriptor);
          if (incompatible !== null) return yield* incompatible;
          return {
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            target,
            httpBaseUrl,
            httpAuthorization: { _tag: "Bearer", token: credential.token },
            connectionMethod: parseRelayAddress(profile.httpBaseUrl) ? "relay" : "direct",
          } satisfies PreparedHttpConnection;
        });
        const preferred = connectionRoutes(entry).reduce<ReadonlyArray<ConnectionRoute>>(
          insertRoute,
          [],
        );
        return yield* connectOverRoutes(
          entryWithRoutes(entry, preferred),
          (route) => checkConnectionRoute(entry, route, LATE_ROUTE_CHECK_TIMEOUT_MS, resolveOrigin),
          (route) => prepare(route).pipe(Effect.flatMap(read)),
        ).pipe(Effect.forkChild, Effect.flatMap(Fiber.join), Effect.scoped);
      }),
    (leases) =>
      Effect.tryPromise({
        try: () => Promise.all([...leases.values()].map(({ lease }) => lease.close())),
        catch: () =>
          new ConnectionTransientError({
            reason: "transport",
            detail: "Background relay cleanup failed.",
          }),
      }).pipe(
        Effect.asVoid,
        Effect.interruptible,
        Effect.timeoutOrElse({
          duration: cleanupMs,
          orElse: () =>
            Effect.fail(
              new ConnectionTransientError({
                reason: "timeout",
                detail: "Background relay cleanup exceeded its grace period.",
              }),
            ),
        }),
      ),
  );
});
