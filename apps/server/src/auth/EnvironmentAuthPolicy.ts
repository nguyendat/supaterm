import type { ServerAuthDescriptor } from "@supaterm/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { TailnetExposure } from "../tailnet/TailnetExposure.ts";
import { isRemoteReachableHost, resolveSessionCookieName } from "./utils.ts";

export class EnvironmentAuthPolicy extends Context.Service<
  EnvironmentAuthPolicy,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
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

  const describe = (isRemoteReachable: boolean): ServerAuthDescriptor => {
    const policy =
      config.mode === "desktop"
        ? isRemoteReachable
          ? "remote-reachable"
          : "desktop-managed-local"
        : isRemoteReachable
          ? "remote-reachable"
          : "loopback-browser";
    return {
      policy,
      bootstrapMethods:
        policy === "desktop-managed-local"
          ? ["desktop-bootstrap"]
          : config.mode === "desktop" && policy === "remote-reachable"
            ? ["desktop-bootstrap", "one-time-token"]
            : ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-access-token"],
      sessionCookieName,
    };
  };
  const local = describe(reachableByConfig);
  const remote = describe(true);

  return EnvironmentAuthPolicy.of({
    getDescriptor: Effect.fn("EnvironmentAuthPolicy.getDescriptor")(() =>
      reachableByConfig
        ? Effect.succeed(remote)
        : tailnet.current.pipe(Effect.map((exposure) => (exposure.serving ? remote : local))),
    ),
  });
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make);
