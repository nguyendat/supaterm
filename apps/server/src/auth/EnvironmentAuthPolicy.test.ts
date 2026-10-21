import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { TailnetExposure, type TailnetExposureState } from "../tailnet/TailnetExposure.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";

const layerEnvironmentAuthPolicy = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuthPolicy.layer.pipe(
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            ...overrides,
          } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "supaterm-auth-policy-test-" }),
        ),
      ),
    ),
  );

it.layer(NodeServices.layer)("EnvironmentAuthPolicy.layer", (it) => {
  it.effect("uses desktop-managed-local policy for desktop mode", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("desktop-managed-local");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap"]);
      expect(descriptor.sessionCookieName).toBe("supaterm_session_3773");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "desktop",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("keeps desktop cookies port-scoped on the port a second instance lands on", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.sessionCookieName).toBe("supaterm_session_3774");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "desktop",
          port: 3774,
        }),
      ),
    ),
  );

  it.effect(
    "accepts one-time tokens on a loopback desktop backend reached through Tailscale Serve",
    () =>
      Effect.gen(function* () {
        const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
        const descriptor = yield* policy.getDescriptor();

        expect(descriptor.policy).toBe("remote-reachable");
        expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
        expect(descriptor.sessionCookieName).toBe("supaterm_session_3773");
      }).pipe(
        Effect.provide(
          layerEnvironmentAuthPolicy({
            mode: "desktop",
            host: "127.0.0.1",
            port: 3773,
            tailscaleServeEnabled: true,
          }),
        ),
      ),
  );

  it.effect("uses remote-reachable policy for desktop mode when bound beyond loopback", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "desktop",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("uses loopback-browser policy for loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("loopback-browser");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      expect(descriptor.sessionCookieName).toMatch(/^supaterm_session_3773_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for wildcard web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      expect(descriptor.sessionCookieName).toMatch(/^supaterm_session_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("isolates wildcard-bound web development sessions", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.sessionCookieName).toMatch(/^supaterm_session_5775_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "0.0.0.0",
          port: 5775,
          devUrl: new URL("http://127.0.0.1:5736"),
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for non-loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.sessionCookieName).toMatch(/^supaterm_session_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "192.168.1.50",
        }),
      ),
    ),
  );

  it.effect.each(["web", "desktop"] as const)(
    "follows the built-in tailnet at runtime in %s mode without changing the cookie",
    (mode) =>
      Effect.gen(function* () {
        const exposure = yield* SubscriptionRef.make<TailnetExposureState>({
          serving: false,
          endpoints: [],
        });
        const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy.pipe(
          Effect.provide(
            layerEnvironmentAuthPolicy({ mode, host: "127.0.0.1", port: 3773 }).pipe(
              Layer.provide(
                Layer.succeed(TailnetExposure, {
                  current: SubscriptionRef.get(exposure),
                  changes: SubscriptionRef.changes(exposure),
                }),
              ),
            ),
          ),
        );
        const local = yield* policy.getDescriptor();
        yield* SubscriptionRef.set(exposure, {
          serving: true,
          endpoints: [{ kind: "tailnet", httpBaseUrl: "https://host.tail1234.ts.net/" }],
        });
        const serving = yield* policy.getDescriptor();

        expect(local.policy).toBe(
          mode === "desktop" ? "desktop-managed-local" : "loopback-browser",
        );
        expect(serving.policy).toBe("remote-reachable");
        expect(serving.bootstrapMethods).toContain("one-time-token");
        expect(serving.sessionCookieName).toBe(local.sessionCookieName);
      }),
  );
});
