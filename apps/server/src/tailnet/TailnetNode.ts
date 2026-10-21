import {
  normalizeTailnetHostname,
  TailnetError,
  TailnetHostname,
  TailnetTag,
  type ServerDirectEndpoint,
  type TailnetConfigureInput,
  type TailnetLoginResult,
  type TailnetPhase,
  type TailnetSignInInput,
  type TailnetSignOutResult,
  type TailnetStatus,
} from "@supaterm/contracts";
import * as HostProcess from "@supaterm/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Hex from "effect/encoding/Hex";
import { fromJsonStringPretty } from "@supaterm/shared/schemaJson";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as TailnetBinary from "./TailnetBinary.ts";
import { TailnetExposure, type TailnetExposureState } from "./TailnetExposure.ts";
import * as TailnetIngress from "./TailnetIngress.ts";
import * as TailnetSidecar from "./TailnetSidecar.ts";

const LOGIN_TIMEOUT = Duration.seconds(30);
const LOGOUT_TIMEOUT = Duration.seconds(20);
const INITIAL_RESTART_DELAY = Duration.seconds(1);
const MAX_RESTART_DELAY = Duration.seconds(60);
// An attempt that ends sooner than this counts toward giving up.
const FAST_FAILURE_WINDOW_MS = 60_000;
const MAX_FAST_FAILURES = 5;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const TailnetConfig = Schema.Struct({
  version: Schema.Literal(1),
  enrolled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  signedIn: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  hostname: Schema.optionalKey(TailnetHostname),
  tags: Schema.Array(TailnetTag).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  serveEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  requireOwner: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  loggingAllowed: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
type TailnetConfig = typeof TailnetConfig.Type;
const DEFAULT_CONFIG = Schema.decodeSync(TailnetConfig)({ version: 1 });
const decodeConfigFile = Schema.decodeUnknownEffect(Schema.fromJsonString(TailnetConfig));
const encodeConfigFile = Schema.encodeEffect(fromJsonStringPretty(TailnetConfig));

type Runtime =
  | { readonly _tag: "Unavailable"; readonly message: string }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Starting" }
  | {
      readonly _tag: "Connected";
      readonly sidecar: TailnetSidecar.TailnetSidecarStatus | undefined;
    }
  | { readonly _tag: "Restarting"; readonly message: string }
  | { readonly _tag: "Failed"; readonly message: string };

interface NodeState {
  readonly config: TailnetConfig;
  readonly runtime: Runtime;
}

const nonEmpty = (value: string | null | undefined) =>
  value === null || value === undefined || value.length === 0 ? undefined : value;

const sidecarOf = (runtime: Runtime) =>
  runtime._tag === "Connected" ? runtime.sidecar : undefined;

function phaseOf({ config, runtime }: NodeState): TailnetPhase {
  if (runtime._tag === "Unavailable") return "unavailable";
  if (!config.enrolled) return "signed-out";
  switch (runtime._tag) {
    case "Stopped":
    case "Starting":
      return "starting";
    case "Restarting":
      return "restarting";
    case "Failed":
      return "error";
    case "Connected":
      switch (runtime.sidecar?.backendState) {
        case "NeedsLogin":
          return config.signedIn ? "needs-reauth" : "needs-login";
        case "NeedsMachineAuth":
          return "needs-approval";
        case "Running":
          return "running";
        default:
          return "starting";
      }
  }
}

const statusOf = (state: NodeState, suggestedHostname: string): TailnetStatus => {
  const { config, runtime } = state;
  const sidecar = sidecarOf(runtime);
  const phase = phaseOf(state);
  const serving = phase === "running" && config.serveEnabled;
  const message = "message" in runtime ? runtime.message : nonEmpty(sidecar?.errMessage);
  const httpsMessage = nonEmpty(sidecar?.httpsMessage);
  const httpsUrl = serving ? nonEmpty(sidecar?.listening?.https) : undefined;
  const httpUrl = serving ? nonEmpty(sidecar?.listening?.http) : undefined;
  const self = phase === "running" || phase === "needs-reauth" ? sidecar?.self : undefined;
  const dnsName = nonEmpty(self?.dnsName)?.replace(/\.$/u, "");
  const ipv4 = nonEmpty(self?.ipv4);
  const loginName = nonEmpty(self?.loginName);
  const displayName = nonEmpty(self?.displayName);
  const keyExpiry = nonEmpty(self?.keyExpiry);
  return {
    phase,
    ...(message === undefined ? {} : { message }),
    suggestedHostname,
    ...(config.hostname === undefined ? {} : { hostname: config.hostname }),
    tags: config.tags,
    serveEnabled: config.serveEnabled,
    requireOwner: config.requireOwner,
    loggingAllowed: config.loggingAllowed,
    loggingRequired: sidecar?.loggingRequired ?? false,
    https: sidecar?.https ?? "pending",
    ...(httpsMessage === undefined ? {} : { httpsMessage }),
    ...(httpsUrl === undefined ? {} : { httpsUrl }),
    ...(httpUrl === undefined ? {} : { httpUrl }),
    ...(self === undefined || self === null
      ? {}
      : {
          self: {
            ...(dnsName === undefined ? {} : { dnsName }),
            ...(ipv4 === undefined ? {} : { ipv4 }),
            ...(loginName === undefined ? {} : { loginName }),
            ...(displayName === undefined ? {} : { displayName }),
            tagged: self.tagged,
            tags: self.tags ?? [],
            ...(keyExpiry === undefined ? {} : { keyExpiry }),
          },
        }),
  };
};

/** HTTPS first: it is the only route with a secure context. */
const exposureOf = (status: TailnetStatus): TailnetExposureState => {
  const endpoints: Array<ServerDirectEndpoint> = [status.httpsUrl, status.httpUrl].flatMap(
    (httpBaseUrl) => (httpBaseUrl === undefined ? [] : [{ kind: "tailnet" as const, httpBaseUrl }]),
  );
  return { serving: endpoints.length > 0, endpoints };
};

const loginOutcome = (
  state: NodeState,
): Effect.Effect<TailnetLoginResult, TailnetError> | undefined => {
  const { runtime } = state;
  if (runtime._tag === "Unavailable" || runtime._tag === "Failed") {
    return Effect.fail(new TailnetError({ reason: "unavailable", detail: runtime.message }));
  }
  const sidecar = sidecarOf(runtime);
  if (sidecar === undefined) return undefined;
  if (sidecar.backendState === "Running" || sidecar.backendState === "NeedsMachineAuth") {
    return Effect.succeed({ loginUrl: null });
  }
  const authUrl = nonEmpty(sidecar.authUrl);
  if (authUrl !== undefined) return Effect.succeed({ loginUrl: authUrl });
  const rejection = nonEmpty(sidecar.errMessage);
  if (sidecar.backendState === "NeedsLogin" && rejection !== undefined) {
    return Effect.fail(new TailnetError({ reason: "rejected", detail: rejection }));
  }
  return undefined;
};

const encodeBase32 = (bytes: Uint8Array) => {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? output + BASE32_ALPHABET[(buffer << (5 - bits)) & 31] : output;
};

const restartDelay = (attempt: number) =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

export class TailnetNode extends Context.Service<
  TailnetNode,
  {
    /** Spawns the helper when enrolled. Returns without waiting for it. */
    readonly start: Effect.Effect<void>;
    readonly status: Stream.Stream<TailnetStatus>;
    readonly currentStatus: Effect.Effect<TailnetStatus>;
    readonly exposure: Effect.Effect<TailnetExposureState>;
    readonly exposureChanges: Stream.Stream<TailnetExposureState>;
    readonly signIn: (input: TailnetSignInInput) => Effect.Effect<TailnetLoginResult, TailnetError>;
    readonly cancelSignIn: Effect.Effect<void, TailnetError>;
    readonly reauthenticate: Effect.Effect<TailnetLoginResult, TailnetError>;
    readonly signOut: Effect.Effect<TailnetSignOutResult, TailnetError>;
    readonly configure: (input: TailnetConfigureInput) => Effect.Effect<void, TailnetError>;
  }
>()("supaterm/tailnet/TailnetNode") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const binary = yield* TailnetBinary.TailnetBinary;
  const sidecar = yield* TailnetSidecar.TailnetSidecar;
  const ingress = yield* TailnetIngress.TailnetIngress;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const username = yield* HostProcess.Username;
  const tailnetDir = path.join(config.stateDir, "tailnet");
  const configPath = path.join(tailnetDir, "config.json");
  const nodeDir = path.join(tailnetDir, "tailscale");

  const environmentHash = encodeBase32(
    yield* crypto
      .digest("SHA-256", new TextEncoder().encode(yield* identity.getEnvironmentId))
      .pipe(Effect.orDie),
  ).slice(0, 10);
  const userLabel = normalizeTailnetHostname(username ?? "").slice(0, 43);
  const suggestedHostname = normalizeTailnetHostname(
    [userLabel, environmentHash, "supaterm"].filter((part) => part.length > 0).join("-"),
  );

  const initialConfig = yield* fileSystem.readFileString(configPath).pipe(
    Effect.flatMap(decodeConfigFile),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(DEFAULT_CONFIG)
          : Effect.logWarning("Could not read the built-in Tailscale settings", {
              error,
            }).pipe(Effect.as(DEFAULT_CONFIG)),
      SchemaError: (error) =>
        Effect.logWarning("Ignoring unreadable built-in Tailscale settings", { error }).pipe(
          Effect.as(DEFAULT_CONFIG),
        ),
    }),
  );
  const initialLaunch = yield* binary.resolve.pipe(Effect.result);
  const state = yield* SubscriptionRef.make<NodeState>({
    config: initialConfig,
    runtime: Result.isFailure(initialLaunch)
      ? { _tag: "Unavailable", message: initialLaunch.failure.message }
      : { _tag: "Stopped" },
  });

  const mutation = yield* Semaphore.make(1);
  const configWrite = yield* Semaphore.make(1);
  const layerScope = yield* Effect.scope;
  let supervisor: Fiber.Fiber<void> | undefined;
  let attached: TailnetSidecar.TailnetSidecarProcess | undefined;
  let pendingAuthKey: string | undefined;
  let logoutWaiter: Deferred.Deferred<boolean> | undefined;

  const readState = () => SubscriptionRef.getUnsafe(state);
  const setRuntime = (runtime: Runtime) =>
    SubscriptionRef.update(state, (current) => ({ ...current, runtime }));

  const latestSelf = (): TailnetIngress.TailnetIngressSelf | undefined => {
    const self = sidecarOf(readState().runtime)?.self;
    return self === undefined || self === null
      ? undefined
      : { ...(self.userId ? { userId: self.userId } : {}), tagged: self.tagged };
  };
  const authorize = (connection: TailnetIngress.TailnetConnection) => {
    const { config: current } = readState();
    return (
      current.enrolled &&
      current.serveEnabled &&
      TailnetIngress.isTailnetOwnerAllowed({
        requireOwner: current.requireOwner,
        connection,
        latestSelf: latestSelf(),
      })
    );
  };
  const recheckConnections = ingress.revoke(authorize);
  const dropConnections = ingress.revoke(() => false);

  const writeConfigFile = Effect.fn("TailnetNode.writeConfig")(function* (next: TailnetConfig) {
    yield* fileSystem.makeDirectory(tailnetDir, { recursive: true, mode: 0o700 });
    const suffix = Hex.encode(yield* crypto.randomBytes(6));
    const temporary = `${configPath}.${suffix}.tmp`;
    const contents = yield* encodeConfigFile(next);
    yield* fileSystem.writeFileString(temporary, `${contents}\n`, { mode: 0o600 });
    yield* fileSystem
      .rename(temporary, configPath)
      .pipe(
        Effect.tapError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
  });
  /** Applied to the latest config under the write lock, so concurrent writers never lose updates. */
  const updateConfig = (update: (current: TailnetConfig) => TailnetConfig) =>
    configWrite.withPermit(
      Effect.gen(function* () {
        const next = update(readState().config);
        yield* writeConfigFile(next);
        yield* SubscriptionRef.update(state, (current) => ({ ...current, config: next }));
      }),
    );

  const wipeNodeDirectory = fileSystem
    .remove(nodeDir, { recursive: true, force: true })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the built-in Tailscale node state", { error }),
      ),
    );

  const applySidecarStatus = Effect.fnUntraced(function* (
    status: TailnetSidecar.TailnetSidecarStatus,
  ) {
    const previousSelf = latestSelf();
    yield* setRuntime({ _tag: "Connected", sidecar: status });
    const nextSelf = latestSelf();
    if (status.backendState === "Running") {
      pendingAuthKey = undefined;
      if (!readState().config.signedIn) {
        yield* updateConfig((current) =>
          current.enrolled ? { ...current, signedIn: true } : current,
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not record the built-in Tailscale sign-in", { error }),
          ),
        );
      }
    }
    if (previousSelf?.userId !== nextSelf?.userId || previousSelf?.tagged !== nextSelf?.tagged) {
      yield* recheckConnections;
    }
  });

  // Runs once per helper event for the life of the helper; the attempt span covers it.
  const handleEvent = Effect.fnUntraced(function* (
    event: TailnetSidecar.TailnetSidecarEvent,
    fatal: { message: string | undefined },
  ) {
    switch (event.type) {
      case "hello":
        return yield* Effect.logDebug("Built-in Tailscale helper started", {
          version: event.version,
          tailscaleVersion: event.tailscaleVersion,
        });
      case "status":
        return yield* applySidecarStatus(event);
      case "loggedOut":
        if (logoutWaiter !== undefined) yield* Deferred.succeed(logoutWaiter, event.confirmed);
        return;
      case "error":
        yield* Effect.logWarning("Built-in Tailscale helper reported an error", {
          code: event.code,
          fatal: event.fatal,
        });
        if (event.fatal) fatal.message = event.message;
        return;
    }
  });

  const runAttempt = Effect.fn("TailnetNode.runAttempt")(function* () {
    const launch = yield* binary.resolve;
    const secret = Hex.encode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
    const address = yield* ingress.listen({ secret, authorize });
    const helper = yield* sidecar.spawn(launch);
    const current = readState().config;
    const authKey = pendingAuthKey;
    yield* helper.send({
      type: "configure",
      dir: nodeDir,
      hostname: current.hostname ?? suggestedHostname,
      tags: current.tags,
      serve: current.serveEnabled,
      allowLogging: current.loggingAllowed,
      ingress: { address, secret },
      ...(authKey === undefined ? {} : { authKey }),
    });
    attached = helper;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (attached === helper) attached = undefined;
      }),
    );
    yield* setRuntime({ _tag: "Connected", sidecar: undefined });
    const fatal: { message: string | undefined } = { message: undefined };
    yield* helper.events.pipe(Stream.runForEach((event) => handleEvent(event, fatal)));
    const exitCode = yield* helper.exitCode;
    return { exitCode, fatal: fatal.message };
  }, Effect.scoped);

  const supervise = Effect.gen(function* () {
    let attempt = 0;
    let fastFailures = 0;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      const outcome = yield* Effect.result(runAttempt());
      if (logoutWaiter !== undefined) yield* Deferred.succeed(logoutWaiter, false);
      yield* dropConnections;
      if (!readState().config.enrolled) return;
      if (Result.isFailure(outcome)) {
        const error = outcome.failure;
        if (
          error._tag === "TailnetBinaryUnsupported" ||
          error._tag === "TailnetBinaryNotFound" ||
          error._tag === "TailnetBinaryNotExecutable"
        ) {
          return yield* setRuntime({ _tag: "Unavailable", message: error.message });
        }
        yield* Effect.logWarning("Built-in Tailscale helper failed", { error });
      } else if (outcome.success.fatal !== undefined) {
        return yield* setRuntime({ _tag: "Failed", message: outcome.success.fatal });
      } else {
        yield* Effect.logWarning("Built-in Tailscale helper exited", {
          exitCode: outcome.success.exitCode,
        });
      }
      const lasted = (yield* Clock.currentTimeMillis) - startedAt;
      if (lasted < FAST_FAILURE_WINDOW_MS) {
        fastFailures += 1;
      } else {
        fastFailures = 0;
        attempt = 0;
      }
      if (fastFailures >= MAX_FAST_FAILURES) {
        return yield* setRuntime({
          _tag: "Failed",
          message: "Built-in Tailscale keeps stopping. Sign out and back in, or restart Supaterm.",
        });
      }
      yield* setRuntime({
        _tag: "Restarting",
        message: "Built-in Tailscale stopped unexpectedly and is restarting.",
      });
      yield* Effect.sleep(restartDelay(attempt));
      attempt += 1;
    }
  });

  const stopSupervisor = Effect.suspend(() => {
    const fiber = supervisor;
    supervisor = undefined;
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
  });
  const restartSupervisor = Effect.gen(function* () {
    yield* stopSupervisor;
    yield* setRuntime({ _tag: "Starting" });
    supervisor = yield* supervise.pipe(Effect.forkIn(layerScope));
  });

  /** Picks up a helper built after the server started. */
  const ensureAvailable = Effect.gen(function* () {
    const launch = yield* binary.resolve.pipe(Effect.result);
    if (Result.isFailure(launch)) {
      yield* setRuntime({ _tag: "Unavailable", message: launch.failure.message });
      return yield* new TailnetError({ reason: "unavailable", detail: launch.failure.message });
    }
    if (readState().runtime._tag === "Unavailable") yield* setRuntime({ _tag: "Stopped" });
  });

  const awaitLogin = SubscriptionRef.changes(state).pipe(
    Stream.map(loginOutcome),
    Stream.filter((outcome) => outcome !== undefined),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new TailnetError({ reason: "unavailable" })),
        onSome: (outcome) => outcome,
      }),
    ),
    Effect.timeoutOrElse({
      duration: LOGIN_TIMEOUT,
      orElse: () => Effect.fail(new TailnetError({ reason: "timeout" })),
    }),
  );

  const exclusive = <A, E>(effect: Effect.Effect<A, E>) =>
    mutation
      .withPermitsIfAvailable(1)(effect)
      .pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new TailnetError({ reason: "busy" })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );
  const saveConfig = (update: (current: TailnetConfig) => TailnetConfig) =>
    updateConfig(update).pipe(
      Effect.mapError(
        () =>
          new TailnetError({
            reason: "unavailable",
            detail: "Could not save the built-in Tailscale settings.",
          }),
      ),
    );
  /** The setting is already saved, and a helper that cannot take it is restarting with it. */
  const sendCommand = (command: TailnetSidecar.TailnetSidecarCommand) =>
    Effect.suspend(() => {
      if (attached === undefined) return Effect.void;
      return attached
        .send(command)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not update the built-in Tailscale helper", { error }),
          ),
        );
    });
  const unenroll = Effect.suspend(() => {
    pendingAuthKey = undefined;
    return saveConfig((value) => ({ ...value, enrolled: false, signedIn: false }));
  });
  const stopAndWipeNode = Effect.gen(function* () {
    yield* stopSupervisor;
    yield* wipeNodeDirectory;
    if (readState().runtime._tag !== "Unavailable") yield* setRuntime({ _tag: "Stopped" });
  });

  const signIn = Effect.fn("TailnetNode.signIn")(function* (input: TailnetSignInInput) {
    const { config: current } = readState();
    if (current.enrolled && current.signedIn) {
      return yield* new TailnetError({
        reason: "rejected",
        detail: "This environment is already signed in to Tailscale. Sign out first.",
      });
    }
    yield* ensureAvailable;
    pendingAuthKey = input.authKey;
    yield* saveConfig((value) => ({
      ...value,
      enrolled: true,
      signedIn: false,
      hostname: input.hostname,
      tags: [...input.tags],
      serveEnabled: true,
      requireOwner: input.tags.length === 0,
    }));
    yield* restartSupervisor;
    return yield* awaitLogin;
  }, exclusive);

  const reauthenticate = Effect.gen(function* () {
    const current = readState();
    if (!current.config.enrolled) return yield* new TailnetError({ reason: "not-signed-in" });
    const phase = phaseOf(current);
    if (phase === "running" || phase === "needs-approval") {
      return { loginUrl: null } satisfies TailnetLoginResult;
    }
    if (attached === undefined || current.runtime._tag !== "Connected") {
      yield* ensureAvailable;
      yield* restartSupervisor;
    } else {
      yield* sendCommand({ type: "login" });
    }
    return yield* awaitLogin;
  }).pipe(exclusive, Effect.withSpan("TailnetNode.reauthenticate"));

  const cancelSignIn = Effect.gen(function* () {
    const { config: current } = readState();
    if (!current.enrolled) return;
    if (current.signedIn) {
      return yield* new TailnetError({
        reason: "rejected",
        detail: "This environment is already signed in to Tailscale. Sign out instead.",
      });
    }
    yield* unenroll;
    yield* stopAndWipeNode;
  }).pipe(exclusive, Effect.withSpan("TailnetNode.cancelSignIn"));

  const signOut = Effect.gen(function* () {
    if (!readState().config.enrolled) return yield* new TailnetError({ reason: "not-signed-in" });
    yield* unenroll;
    yield* dropConnections;
    let remoteLogoutConfirmed = false;
    const helper = attached;
    if (helper !== undefined) {
      const waiter = yield* Deferred.make<boolean>();
      logoutWaiter = waiter;
      remoteLogoutConfirmed = yield* helper.send({ type: "logout" }).pipe(
        Effect.andThen(Deferred.await(waiter)),
        Effect.timeoutOrElse({ duration: LOGOUT_TIMEOUT, orElse: () => Effect.succeed(false) }),
        Effect.orElseSucceed(() => false),
        Effect.ensuring(
          Effect.sync(() => {
            logoutWaiter = undefined;
          }),
        ),
      );
    }
    yield* stopAndWipeNode;
    return { remoteLogoutConfirmed } satisfies TailnetSignOutResult;
  }).pipe(exclusive, Effect.withSpan("TailnetNode.signOut"));

  const configure = Effect.fn("TailnetNode.configure")(function* (input: TailnetConfigureInput) {
    const before = readState().config;
    yield* saveConfig((value) => ({
      ...value,
      ...(input.serveEnabled === undefined ? {} : { serveEnabled: input.serveEnabled }),
      ...(input.requireOwner === undefined ? {} : { requireOwner: input.requireOwner }),
      ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
      ...(input.loggingAllowed === undefined ? {} : { loggingAllowed: input.loggingAllowed }),
    }));
    if (input.serveEnabled !== undefined && input.serveEnabled !== before.serveEnabled) {
      yield* sendCommand({ type: "setServe", enabled: input.serveEnabled });
      if (!input.serveEnabled) yield* dropConnections;
    }
    if (input.requireOwner === true && !before.requireOwner) yield* recheckConnections;
    if (input.hostname !== undefined && input.hostname !== before.hostname) {
      yield* sendCommand({ type: "setHostname", hostname: input.hostname });
    }
    if (
      input.loggingAllowed !== undefined &&
      input.loggingAllowed !== before.loggingAllowed &&
      supervisor !== undefined
    ) {
      yield* restartSupervisor;
    }
  }, exclusive);

  const start = Effect.gen(function* () {
    const current = readState();
    if (!current.config.enrolled || current.runtime._tag === "Unavailable") return;
    if (supervisor === undefined) yield* restartSupervisor;
  }).pipe(mutation.withPermit, Effect.withSpan("TailnetNode.start"));

  const toStatus = (value: NodeState) => statusOf(value, suggestedHostname);
  const currentStatus = SubscriptionRef.get(state).pipe(Effect.map(toStatus));
  const status = SubscriptionRef.changes(state).pipe(Stream.map(toStatus), Stream.changes);

  return TailnetNode.of({
    start,
    status,
    currentStatus,
    exposure: Effect.map(currentStatus, exposureOf),
    exposureChanges: status.pipe(Stream.map(exposureOf), Stream.changes),
    signIn,
    cancelSignIn,
    reauthenticate,
    signOut,
    configure,
  });
});

export const layer = Layer.effect(TailnetNode, make);

export const layerExposure = Layer.effect(
  TailnetExposure,
  Effect.map(TailnetNode, (node) => ({
    current: node.exposure,
    changes: node.exposureChanges,
  })),
);
