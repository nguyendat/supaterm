import * as NodeServices from "@effect/platform-node/NodeServices";
import type { TailnetPhase, TailnetStatus } from "@supaterm/contracts";
import * as HostProcess from "@supaterm/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

const makeHarness = (mode: "default" | "pending" | "crash-once" | "unknown-state") => {
  const revocations: Array<boolean> = [];
  const ownerRequests: Array<Fiber.Fiber<unknown, unknown>> = [];
  const layer = TailnetNode.layer.pipe(
    Layer.provide(Layer.succeed(TailnetNode.TailnetRestartDelay, Duration.zero)),
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
          Effect.suspend(() => {
            const allowed = allow(owner);
            revocations.push(allowed);
            // Revoking the owner's socket ends every request that arrived over it.
            return allowed
              ? Effect.void
              : Effect.forEach(ownerRequests.splice(0), Fiber.interrupt, { discard: true });
          }).pipe(Effect.as(0)),
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
  return { layer, revocations, ownerRequests };
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

  it.live("reads a backend state it does not know as starting", () => {
    const harness = makeHarness("unknown-state");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const phases = yield* node.status.pipe(
        Stream.map((status) => status.phase),
        Stream.takeUntil((phase) => phase === "needs-login"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const result = yield* node.signIn({ hostname: "khoi-laptop", tags: [] });
      expect(result.loginUrl).toBe("https://login.tailscale.com/a/fake1");
      expect(yield* Fiber.join(phases)).toEqual(["signed-out", "starting", "needs-login"]);
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

  it.live("finishes signing out after revoking the socket its request arrived on", () => {
    const harness = makeHarness("default");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* node.signIn({ hostname: "khoi-laptop", tags: [], authKey: "tskey-auth-fake" });
      yield* awaitPhase(node, "running");

      const request = yield* node.signOut.pipe(Effect.forkScoped);
      harness.ownerRequests.push(request);
      expect(Exit.hasInterrupts(yield* Fiber.await(request))).toBe(true);
      // Queues behind the sign-out, which still holds the lock.
      yield* node.start;
      expect(yield* fileSystem.exists(yield* nodeDirectory)).toBe(false);
      expect((yield* node.currentStatus).phase).toBe("signed-out");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("cancels a sign-in that is still waiting for its login URL", () => {
    const harness = makeHarness("pending");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const fileSystem = yield* FileSystem.FileSystem;
      const signIn = yield* node
        .signIn({ hostname: "khoi-laptop", tags: [] })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* awaitPhase(node, "needs-login");

      yield* node.cancelSignIn;
      expect(yield* Fiber.join(signIn)).toMatchObject({
        reason: "rejected",
        detail: "Sign-in was cancelled.",
      });
      expect((yield* node.currentStatus).phase).toBe("signed-out");
      expect(yield* fileSystem.exists(yield* nodeDirectory)).toBe(false);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("replaces an unfinished sign-in with a fresh node for the new hostname and tags", () => {
    const harness = makeHarness("default");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* node.signIn({ hostname: "khoi-first", tags: ["tag:old"] });
      const leftover = path.join(yield* nodeDirectory, "leftover");
      yield* fileSystem.writeFileString(leftover, "");

      const result = yield* node.signIn({ hostname: "khoi-second", tags: [] });
      expect(result.loginUrl).toBe("https://login.tailscale.com/a/fake1");
      expect(yield* fileSystem.exists(leftover)).toBe(false);
      expect(yield* readJson(Launch, path.join(yield* nodeDirectory, "launch.json"))).toMatchObject(
        { hostname: "khoi-second", tags: [] },
      );
      expect(yield* node.currentStatus).toMatchObject({
        phase: "needs-login",
        hostname: "khoi-second",
        tags: [],
        requireOwner: true,
      });
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("reports busy while another change is in flight", () => {
    const harness = makeHarness("pending");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const signIn = yield* node
        .signIn({ hostname: "khoi-laptop", tags: [] })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* awaitPhase(node, "needs-login");

      yield* node.signOut.pipe(Effect.forkScoped);
      yield* awaitPhase(node, "signed-out");
      expect(yield* node.configure({ requireOwner: false }).pipe(Effect.flip)).toMatchObject({
        reason: "busy",
      });
      expect(yield* Fiber.join(signIn)).toMatchObject({ detail: "Sign-in was cancelled." });
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("restarts a crashed helper from its saved sign-in and restores its endpoints", () => {
    const harness = makeHarness("crash-once");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const path = yield* Path.Path;
      const recovery = yield* node.status.pipe(
        Stream.dropWhile((status) => status.phase !== "restarting"),
        Stream.takeUntil((status) => status.phase === "running"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* node.signIn({ hostname: "khoi-laptop", tags: [], authKey: "tskey-auth-fake" });

      const [restarting, ...rest] = yield* Fiber.join(recovery);
      expect(restarting).toMatchObject({ phase: "restarting" });
      expect(restarting).not.toHaveProperty("httpsUrl");
      expect(harness.revocations).toContain(false);
      expect(rest.at(-1)).toMatchObject({ phase: "running" });
      expect(yield* node.exposure).toEqual({
        serving: true,
        endpoints: [
          { kind: "tailnet", httpBaseUrl: "https://fake.tailnet.ts.net/" },
          { kind: "tailnet", httpBaseUrl: "http://100.64.0.1/" },
        ],
      });
      const launch = yield* readJson(Launch, path.join(yield* nodeDirectory, "launch.json"));
      expect(launch.authKey).toBeNull();
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("resends an unchanged hostname and shows the rename error until the next rename", () => {
    const harness = makeHarness("default");
    return Effect.gen(function* () {
      const node = yield* TailnetNode.TailnetNode;
      const awaitMessage = (text: string) =>
        node.status.pipe(
          Stream.filter((status) => status.message?.includes(text) === true),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
      yield* node.signIn({ hostname: "khoi-laptop", tags: [], authKey: "tskey-auth-fake" });
      yield* awaitPhase(node, "running");

      yield* node.configure({ hostname: "taken-name" });
      expect((yield* awaitMessage("rename 1")).message).toBe(
        "Could not rename this machine on Tailscale: taken-name is in use (rename 1)",
      );
      yield* node.configure({ hostname: "taken-name" });
      yield* awaitMessage("rename 2");

      yield* node.configure({ hostname: "khoi-renamed" });
      expect(yield* node.currentStatus).toMatchObject({
        phase: "running",
        hostname: "khoi-renamed",
      });
      expect((yield* node.currentStatus).message).toBeUndefined();
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });
});
