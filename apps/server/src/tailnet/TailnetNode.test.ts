import * as NodeServices from "@effect/platform-node/NodeServices";
import type { TailnetPhase, TailnetStatus } from "@supaterm/contracts";
import * as HostProcess from "@supaterm/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as TailnetBinary from "./TailnetBinary.ts";
import * as TailnetIngress from "./TailnetIngress.ts";
import * as TailnetNode from "./TailnetNode.ts";
import * as TailnetSidecar from "./TailnetSidecar.ts";

const FIXTURE = `${import.meta.dirname}/testing/TailnetSidecar.fixture.mjs`;

const Launch = Schema.fromJsonString(
  Schema.Struct({
    environment: Schema.Array(Schema.String),
    authKey: Schema.NullOr(Schema.String),
    hostname: Schema.String,
    tags: Schema.Array(Schema.String),
    secretLength: Schema.Number,
  }),
);
const ConfigFile = Schema.fromJsonString(
  Schema.Struct({
    enrolled: Schema.Boolean,
    hostname: Schema.optionalKey(Schema.String),
    requireOwner: Schema.Boolean,
  }),
);

const owner: TailnetIngress.TailnetConnection = {
  tls: true,
  peer: { ip: "100.64.0.2", userId: "123456789012345678", tagged: false },
  self: { userId: "123456789012345678", tagged: false },
};

const makeHarness = (mode: "default" | "silent" | "crash") => {
  const revocations: Array<boolean> = [];
  const layer = TailnetNode.layer.pipe(
    Layer.provide(TailnetSidecar.layer),
    Layer.provide(
      Layer.succeed(TailnetBinary.TailnetBinary, {
        resolve: Effect.succeed({ command: process.execPath, args: [FIXTURE, mode] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(TailnetIngress.TailnetIngress, {
        listen: () => Effect.succeed("fake-ingress"),
        revoke: (allow) =>
          Effect.sync(() => {
            revocations.push(allow(owner));
            return 0;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        PATH: process.env.PATH,
        TS_AUTHKEY: "tskey-from-the-environment",
        SUPATERM_HOME: "/must/not/leak",
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.Username, "Khoi Test")),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "supaterm-tailnet-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, revocations };
};

const awaitPhase = (node: TailnetNode.TailnetNode["Service"], phase: TailnetPhase) =>
  node.status.pipe(
    Stream.filter((status) => status.phase === phase),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const nodeDirectory = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "tailnet", "tailscale");
});

const readJson = <S extends Schema.Top>(schema: S, file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(file)),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  );

describe("TailnetNode", () => {
  it.live("returns the login URL from sign-in and never puts it in status", () => {
    const harness = makeHarness("default");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const path = yield* Path.Path;
      const seen: Array<TailnetStatus> = [];
      yield* node.status.pipe(
        Stream.runForEach((status) => Effect.sync(() => seen.push(status))),
        Effect.forkScoped,
      );
      expect((yield* node.currentStatus).phase).toBe("signed-out");

      const result = yield* node.signIn({ hostname: "khoi-laptop", tags: [] });
      expect(result.loginUrl).toBe("https://login.tailscale.com/a/fake1");
      const pending = yield* awaitPhase(node, "needs-login");
      expect(pending).toMatchObject({
        hostname: "khoi-laptop",
        serveEnabled: true,
        requireOwner: true,
      });
      expect(pending.suggestedHostname).toMatch(/^khoi-test-[a-z2-7]{10}-supaterm$/u);

      const reauthenticated = yield* node.reauthenticate;
      expect(reauthenticated.loginUrl).toMatch(/^https:\/\/login\.tailscale\.com\/a\/fake\d$/u);
      expect(JSON.stringify([...seen, yield* node.currentStatus])).not.toContain(
        "login.tailscale.com",
      );

      const launch = yield* readJson(Launch, path.join(yield* nodeDirectory, "launch.json"));
      expect(launch.environment).toContain("PATH");
      expect(launch.environment).not.toContain("TS_AUTHKEY");
      expect(launch.environment).not.toContain("SUPATERM_HOME");
      expect(launch.secretLength).toBe(64);
      expect(launch.authKey).toBeNull();
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("serves endpoints once running and withdraws them when serving stops", () => {
    const harness = makeHarness("default");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const path = yield* Path.Path;
      const result = yield* node.signIn({
        hostname: "khoi-laptop",
        tags: [],
        authKey: "tskey-auth-fake",
      });
      expect(result).toEqual({ loginUrl: null });

      const running = yield* awaitPhase(node, "running");
      expect(running).toMatchObject({
        https: "ready",
        httpsUrl: "https://fake.tailnet.ts.net/",
        httpUrl: "http://100.64.0.1/",
      });
      expect(running.self).toEqual({
        dnsName: "fake.tailnet.ts.net",
        ipv4: "100.64.0.1",
        loginName: "khoi@github",
        displayName: "Khoi",
        tagged: false,
        tags: [],
        keyExpiry: "2027-04-19T00:00:00Z",
      });
      expect(yield* node.exposure).toEqual({
        serving: true,
        endpoints: [
          { kind: "tailnet", httpBaseUrl: "https://fake.tailnet.ts.net/" },
          { kind: "tailnet", httpBaseUrl: "http://100.64.0.1/" },
        ],
      });
      const launch = yield* readJson(Launch, path.join(yield* nodeDirectory, "launch.json"));
      expect(launch.authKey).toBe("tskey-auth-fake");

      yield* node.configure({ serveEnabled: false });
      expect(yield* node.exposure).toEqual({ serving: false, endpoints: [] });
      expect((yield* node.currentStatus).httpsUrl).toBeUndefined();
      expect(harness.revocations).toContain(false);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("signs out remotely, wipes the node state, and keeps the hostname", () => {
    const harness = makeHarness("default");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* node.signIn({ hostname: "khoi-laptop", tags: [], authKey: "tskey-auth-fake" });
      yield* awaitPhase(node, "running");
      const directory = yield* nodeDirectory;
      expect(yield* fileSystem.exists(path.join(directory, "tailscaled.state"))).toBe(true);

      expect(yield* node.signOut).toEqual({ remoteLogoutConfirmed: true });
      expect(yield* fileSystem.exists(directory)).toBe(false);
      expect(yield* node.currentStatus).toMatchObject({
        phase: "signed-out",
        hostname: "khoi-laptop",
      });
      expect(harness.revocations).toContain(false);
      expect(
        yield* readJson(ConfigFile, path.join(config.stateDir, "tailnet", "config.json")),
      ).toEqual({ enrolled: false, hostname: "khoi-laptop", requireOwner: true });
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("cancels a pending sign-in and refuses to reauthenticate afterwards", () => {
    const harness = makeHarness("default");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* node.signIn({ hostname: "khoi-laptop", tags: ["tag:supaterm"] });
      expect((yield* awaitPhase(node, "needs-login")).requireOwner).toBe(false);

      yield* node.cancelSignIn;
      expect((yield* node.currentStatus).phase).toBe("signed-out");
      expect(yield* fileSystem.exists(yield* nodeDirectory)).toBe(false);
      expect(yield* node.reauthenticate.pipe(Effect.flip)).toMatchObject({
        reason: "not-signed-in",
      });
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("reports busy while another change is in flight", () => {
    const harness = makeHarness("silent");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const signIn = yield* node
        .signIn({ hostname: "khoi-laptop", tags: [] })
        .pipe(Effect.forkScoped);
      yield* awaitPhase(node, "starting");
      expect(yield* node.configure({ requireOwner: false }).pipe(Effect.flip)).toMatchObject({
        reason: "busy",
      });
      yield* Fiber.interrupt(signIn);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("withdraws endpoints and restarts when the helper crashes", () => {
    const harness = makeHarness("crash");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      yield* node.signIn({ hostname: "khoi-laptop", tags: [], authKey: "tskey-auth-fake" });
      const restarting = yield* awaitPhase(node, "restarting");
      expect(restarting.httpsUrl).toBeUndefined();
      expect(harness.revocations).toContain(false);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });
});
