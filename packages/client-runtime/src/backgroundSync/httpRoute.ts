import type { ExecutionEnvironmentDescriptor } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "../connection/catalog.ts";
import { orchestrationProtocolCompatibilityError } from "../connection/compatibility.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import {
  connectOverRoutes,
  LATE_ROUTE_CHECK_TIMEOUT_MS,
  type RouteCheck,
} from "../connection/driver.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
} from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type EnvironmentHttpEndpoint,
} from "../connection/model.ts";
import {
  connectionRouteId,
  connectionRoutes,
  credentialConnectionId,
  entryWithRoutes,
} from "../connection/routes.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { leaseRelayOrigin } from "../relay/gateway.ts";

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

export interface HttpRoute<A> {
  readonly route: ConnectionRoute;
  readonly endpoint: EnvironmentHttpEndpoint;
  readonly value: A;
}

/**
 * Saved routes a headless reader can use, keyed by route id: bearer routes with
 * an HTTP address. SSH and the desktop's own primary route need the desktop app.
 */
function httpReadableRoutes(
  entry: ConnectionCatalogEntry,
): ReadonlyMap<string, BearerConnectionProfile> {
  const readable = new Map<string, BearerConnectionProfile>();
  for (const route of connectionRoutes(entry)) {
    const profile = Option.getOrNull(route.profile);
    if (
      route.target._tag === "BearerConnectionTarget" &&
      profile !== null &&
      isBearerProfile(profile)
    )
      readable.set(connectionRouteId(route.target), profile);
  }
  return readable;
}

/**
 * Reads from the first saved route, in the driver's preference and fallback
 * order, that serves `read`. Unlike the socket driver it never mints a socket
 * ticket or reports client presence: a route is proven by its public
 * descriptor before the bearer credential is sent, and `read` itself is the
 * connection attempt, so a route whose credential is rejected falls through to
 * the next one. Relay tunnels opened here close with the caller's scope.
 */
export const openHttpRoute = Effect.fn("BackgroundSync.openHttpRoute")(function* <A, R>(
  entry: ConnectionCatalogEntry,
  read: (endpoint: EnvironmentHttpEndpoint) => Effect.Effect<A, ConnectionAttemptError, R>,
) {
  const profiles = httpReadableRoutes(entry);
  const routes = connectionRoutes(entry).filter((route) =>
    profiles.has(connectionRouteId(route.target)),
  );
  if (routes.length === 0) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `${entry.target.label} has no saved route that can be read without the desktop app.`,
    });
  }
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const scope = yield* Scope.Scope;
  const expectedEnvironmentId = entry.target.environmentId;
  const descriptors = new Map<string, ExecutionEnvironmentDescriptor>();
  const profileOf = (route: ConnectionRoute) => profiles.get(connectionRouteId(route.target))!;

  const resolveOrigin = (profile: BearerConnectionProfile) =>
    leaseRelayOrigin(profile.httpBaseUrl, profile.relayUrl).pipe(
      Effect.map((lease) => lease.origin),
    );

  // The descriptor is public, so a check sends no credential to whatever
  // answers at a saved LAN address on a different network.
  const checkRoute = (route: ConnectionRoute) =>
    resolveOrigin(profileOf(route)).pipe(
      Effect.flatMap((httpBaseUrl) =>
        fetchRemoteEnvironmentDescriptor({ httpBaseUrl, timeoutMs: LATE_ROUTE_CHECK_TIMEOUT_MS }),
      ),
      Effect.map((descriptor): RouteCheck => {
        if (descriptor.environmentId !== expectedEnvironmentId) return "silent";
        descriptors.set(connectionRouteId(route.target), descriptor);
        return "answered";
      }),
      Effect.timeoutOrElse({
        duration: LATE_ROUTE_CHECK_TIMEOUT_MS,
        orElse: () => Effect.succeed<RouteCheck>("silent"),
      }),
      Effect.orElseSucceed((): RouteCheck => "silent"),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Scope.provide(scope),
    );

  const connectRoute = Effect.fnUntraced(function* (route: ConnectionRoute) {
    const profile = profileOf(route);
    const httpBaseUrl = yield* resolveOrigin(profile);
    const descriptor =
      descriptors.get(connectionRouteId(route.target)) ??
      (yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ));
    if (descriptor.environmentId !== expectedEnvironmentId) {
      return yield* environmentMismatchError({
        expected: expectedEnvironmentId,
        actual: descriptor.environmentId,
      });
    }
    const incompatible = orchestrationProtocolCompatibilityError(descriptor);
    if (incompatible !== null) return yield* incompatible;
    const credential = yield* credentials.get(credentialConnectionId(profile.connectionId));
    if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
      return yield* credentialMissingError(profile.connectionId);
    }
    const endpoint: EnvironmentHttpEndpoint = {
      httpBaseUrl,
      httpAuthorization: { _tag: "Bearer", token: credential.value.token },
    };
    const value = yield* read(endpoint);
    return { route, endpoint, value } satisfies HttpRoute<A>;
  });

  return yield* connectOverRoutes(entryWithRoutes(entry, routes), checkRoute, connectRoute);
});
