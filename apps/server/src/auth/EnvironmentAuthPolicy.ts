import type { ServerAuthDescriptor } from "@supaterm/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { TailnetExposure, type TailnetExposureState } from "../tailnet/TailnetExposure.ts";
import { isRemoteReachableHost, resolveSessionCookieName } from "./utils.ts";

export class EnvironmentAuthPolicy extends Context.Service<
  EnvironmentAuthPolicy,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
    readonly descriptorFor: (exposure: TailnetExposureState) => ServerAuthDescriptor;
  }
>()("supaterm/auth/EnvironmentAuthPolicy") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const tailnet = yield* TailnetExposure;
  const reachableByConfig = config.tailscaleServeEnabled || isRemoteReachableHost(config.host);

  // The built-in tailnet node changes reachability at runtime; the cookie name must not follow
  // it, or every browser session would drop when serving starts or stops.
  const sessionCookieName = resolveSessionCookieName({
    mode: config.mode,
    port: config.port,
    host: config.host,
    instanceKey: config.stateDir,
    environmentId: yield* serverEnvironment.getEnvironmentId,
    development: config.devUrl !== undefined,
  });

  const isDesktop = config.mode === "desktop";
  const local: ServerAuthDescriptor = {
    policy: isDesktop ? "desktop-managed-local" : "loopback-browser",
    bootstrapMethods: isDesktop ? ["desktop-bootstrap"] : ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName,
  };
  const remote: ServerAuthDescriptor = {
    policy: "remote-reachable",
    bootstrapMethods: isDesktop ? ["desktop-bootstrap", "one-time-token"] : ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName,
  };

  const descriptorFor = (exposure: TailnetExposureState) =>
    reachableByConfig || exposure.serving ? remote : local;

  return EnvironmentAuthPolicy.of({
    getDescriptor: Effect.fn("EnvironmentAuthPolicy.getDescriptor")(() =>
      tailnet.current.pipe(Effect.map(descriptorFor)),
    ),
    descriptorFor,
  });
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make);
