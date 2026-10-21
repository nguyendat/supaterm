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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
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

const SIGN_IN_CANCELLED = Exit.fail(
  new TailnetError({ reason: "rejected", detail: "Sign-in was cancelled." }),
);
const SIGN_IN_REPLACED = Exit.fail(
  new TailnetError({ reason: "rejected", detail: "A newer sign-in replaced this one." }),
);

/** Nonfatal helper errors that stay in `TailnetStatus.message` until superseded. */
const NOTICE_PREFIXES = {
  "set-hostname": "Could not rename this machine on Tailscale",
  login: "Could not start Tailscale sign-in",
  listen: "Could not start serving on Tailscale",
} as const;
type NoticeCode = keyof typeof NOTICE_PREFIXES;
const isNoticeCode = (code: string): code is NoticeCode => Object.hasOwn(NOTICE_PREFIXES, code);

const NOTICE_OF_COMMAND = {
  login: "login",
  setHostname: "set-hostname",
  setServe: "listen",
} as const satisfies Record<string, NoticeCode>;
type FollowUpCommand = Extract<
  TailnetSidecar.TailnetSidecarCommand,
  { readonly type: keyof typeof NOTICE_OF_COMMAND }
>;

interface Notice {
  readonly code: NoticeCode;
  readonly message: string;
}

interface Connected {
  readonly _tag: "Connected";
  readonly sidecar: TailnetSidecar.TailnetSidecarStatus | undefined;
  readonly notices: ReadonlyArray<Notice>;
}

type Runtime =
  | { readonly _tag: "Unavailable"; readonly message: string }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Starting" }
  | Connected
  | { readonly _tag: "Restarting"; readonly message: string }
  | { readonly _tag: "Failed"; readonly message: string };

interface NodeState {
  readonly config: TailnetConfig;
  readonly runtime: Runtime;
}

/** Whether a later status shows that the concern behind a notice has recovered. */
const resolves = (status: TailnetSidecar.TailnetSidecarStatus, code: NoticeCode) => {
  switch (code) {
    case "login":
      return (
        status.authUrl !== undefined ||
        status.backendState === "Running" ||
        status.backendState === "NeedsMachineAuth"
      );
    case "listen":
      return (
        status.listening.http !== undefined &&
        (status.https !== "ready" || status.listening.https !== undefined)
      );
    case "set-hostname":
      return false;
  }
};

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
  const connected = runtime._tag === "Connected" ? runtime : undefined;
  const sidecar = connected?.sidecar;
  const phase = phaseOf(state);
  const serving = phase === "running" && config.serveEnabled;
  const message =
    "message" in runtime
      ? runtime.message
      : (connected?.notices.at(-1)?.message ?? sidecar?.errMessage);
  const httpsMessage = sidecar?.httpsMessage;
  const httpsUrl = serving ? sidecar?.listening.https : undefined;
  const httpUrl = serving ? sidecar?.listening.http : undefined;
  const self = phase === "running" || phase === "needs-reauth" ? sidecar?.self : undefined;
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
    ...(self === undefined ? {} : { self: Struct.omit(self, ["userId", "ipv6"]) }),
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
  runtime: Runtime,
): Exit.Exit<TailnetLoginResult, TailnetError> | undefined => {
  if (runtime._tag === "Unavailable" || runtime._tag === "Failed") {
    return Exit.fail(new TailnetError({ reason: "unavailable", detail: runtime.message }));
  }
  if (runtime._tag !== "Connected") return undefined;
  const { sidecar, notices } = runtime;
  if (sidecar?.backendState === "Running" || sidecar?.backendState === "NeedsMachineAuth") {
    return Exit.succeed({ loginUrl: null });
  }
  if (sidecar?.authUrl !== undefined) return Exit.succeed({ loginUrl: sidecar.authUrl });
  const rejection =
    notices.find((notice) => notice.code === "login")?.message ??
    (sidecar?.backendState === "NeedsLogin" ? sidecar.errMessage : undefined);
  return rejection === undefined
    ? undefined
    : Exit.fail(new TailnetError({ reason: "rejected", detail: rejection }));
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

export class TailnetRestartDelay extends Context.Reference<Duration.Duration>(
  "supaterm/tailnet/TailnetRestartDelay",
  { defaultValue: () => Duration.seconds(1) },
) {}

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
  const restartBaseDelay = yield* TailnetRestartDelay;
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
  let launchedLoggingAllowed: boolean | undefined;
  let pendingAuthKey: string | undefined;
  let loginWaiter: Deferred.Deferred<TailnetLoginResult, TailnetError> | undefined;
  let logoutWaiter: Deferred.Deferred<boolean> | undefined;

  const readState = () => SubscriptionRef.getUnsafe(state);

  const settleLogin = (exit: Exit.Exit<TailnetLoginResult, TailnetError>) =>
    Effect.suspend(() => {
      const waiter = loginWaiter;
      loginWaiter = undefined;
      return waiter === undefined ? Effect.void : Effect.asVoid(Deferred.done(waiter, exit));
    });
  /** Callers that overlap share one attempt. */
  const beginLogin = Effect.gen(function* () {
    const waiter = loginWaiter ?? (yield* Deferred.make<TailnetLoginResult, TailnetError>());
    loginWaiter = waiter;
    return waiter;
  });
  const awaitLogin = (waiter: Deferred.Deferred<TailnetLoginResult, TailnetError>) =>
    Deferred.await(waiter).pipe(
      Effect.timeoutOrElse({
        duration: LOGIN_TIMEOUT,
        orElse: () => Effect.fail(new TailnetError({ reason: "timeout" })),
      }),
    );

  /** Every runtime change may be the one that answers a pending sign-in. */
  const updateRuntime = (update: (runtime: Runtime) => Runtime) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      runtime: update(current.runtime),
    })).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const outcome = loginWaiter === undefined ? undefined : loginOutcome(readState().runtime);
          return outcome === undefined ? Effect.void : settleLogin(outcome);
        }),
      ),
    );
  const setRuntime = (runtime: Runtime) => updateRuntime(() => runtime);
  const updateConnected = (update: (runtime: Connected) => Connected) =>
    updateRuntime((runtime) => (runtime._tag === "Connected" ? update(runtime) : runtime));

  const latestSelf = () => {
    const { runtime } = readState();
    const self = runtime._tag === "Connected" ? runtime.sidecar?.self : undefined;
    return self === undefined ? undefined : { userId: self.userId, tagged: self.tagged };
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
    yield* updateConnected((runtime) => ({
      ...runtime,
      sidecar: status,
      notices: runtime.notices.filter((notice) => !resolves(status, notice.code)),
    }));
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
      case "error": {
        yield* Effect.logWarning("Built-in Tailscale helper reported an error", {
          code: event.code,
          fatal: event.fatal,
        });
        if (event.fatal) {
          fatal.message = event.message;
          return;
        }
        const code = event.code;
        if (!isNoticeCode(code)) return;
        return yield* updateConnected((runtime) => ({
          ...runtime,
          notices: [
            ...runtime.notices.filter((notice) => notice.code !== code),
            { code, message: `${NOTICE_PREFIXES[code]}: ${event.message}` },
          ],
        }));
      }
    }
  });

  const runAttempt = Effect.fn("TailnetNode.runAttempt")(function* () {
    const launch = yield* binary.resolve;
    const secret = Hex.encode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
    const address = yield* ingress.listen({ secret, authorize });
    const helper = yield* sidecar.spawn(launch);
    const sent = readState().config;
    const authKey = pendingAuthKey;
    launchedLoggingAllowed = sent.loggingAllowed;
    yield* helper.send({
      type: "configure",
      dir: nodeDir,
      hostname: sent.hostname ?? suggestedHostname,
      tags: sent.tags,
      serve: sent.serveEnabled,
      allowLogging: sent.loggingAllowed,
      ingress: { address, secret },
      ...(authKey === undefined ? {} : { authKey }),
    });
    attached = helper;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (attached === helper) attached = undefined;
      }),
    );
    yield* setRuntime({ _tag: "Connected", sidecar: undefined, notices: [] });
    // Settings saved while configure was being written found no helper to tell.
    const latest = readState().config;
    if (latest.serveEnabled !== sent.serveEnabled) {
      yield* helper.send({ type: "setServe", enabled: latest.serveEnabled });
    }
    if (latest.hostname !== undefined && latest.hostname !== sent.hostname) {
      yield* helper.send({ type: "setHostname", hostname: latest.hostname });
    }
    const fatal: { message: string | undefined } = { message: undefined };
    yield* helper.events.pipe(Stream.runForEach((event) => handleEvent(event, fatal)));
    const exitCode = yield* helper.exitCode;
    return { exitCode, fatal: fatal.message };
  }, Effect.scoped);

  const restartDelay = (attempt: number) =>
    Duration.min(Duration.times(restartBaseDelay, 2 ** attempt), MAX_RESTART_DELAY);

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
  const startSupervisor = Effect.gen(function* () {
    yield* setRuntime({ _tag: "Starting" });
    supervisor = yield* supervise.pipe(Effect.forkIn(layerScope));
  });
  const restartSupervisor = Effect.andThen(stopSupervisor, startSupervisor);

  /** Picks up a helper built after the server started. */
  const ensureAvailable = Effect.gen(function* () {
    const launch = yield* binary.resolve.pipe(Effect.result);
    if (Result.isFailure(launch)) {
      yield* setRuntime({ _tag: "Unavailable", message: launch.failure.message });
      return yield* new TailnetError({ reason: "unavailable", detail: launch.failure.message });
    }
    if (readState().runtime._tag === "Unavailable") yield* setRuntime({ _tag: "Stopped" });
  });

  /**
   * Runs a change under the lock in a fiber the service owns. A change can disconnect the client
   * that asked for it, and interrupting that request must not cut the change short.
   */
  const transition = <A>(change: Effect.Effect<A, TailnetError>) =>
    mutation
      .withPermitsIfAvailable(1)(change)
      .pipe(
        Effect.forkIn(layerScope),
        Effect.flatMap(Fiber.join),
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
  /** Without a helper there is nothing to tell: the next one starts from the saved settings. */
  const sendCommand = (command: FollowUpCommand) =>
    Effect.suspend(() => {
      const helper = attached;
      if (helper === undefined) return Effect.void;
      const code = NOTICE_OF_COMMAND[command.type];
      return updateConnected((runtime) => ({
        ...runtime,
        notices: runtime.notices.filter((notice) => notice.code !== code),
        // The helper drops its last control error on login; a stale one would answer this attempt.
        sidecar:
          command.type === "login" && runtime.sidecar !== undefined
            ? Struct.omit(runtime.sidecar, ["errMessage"])
            : runtime.sidecar,
      })).pipe(
        Effect.andThen(helper.send(command)),
        Effect.mapError(
          (error) => new TailnetError({ reason: "unavailable", detail: error.message }),
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
    const waiter = yield* transition(
      Effect.gen(function* () {
        const previous = readState().config;
        if (previous.enrolled && previous.signedIn) {
          return yield* new TailnetError({
            reason: "rejected",
            detail: "This environment is already signed in to Tailscale. Sign out first.",
          });
        }
        yield* ensureAvailable;
        // A pending enrollment's node already registered its hostname and tags, so start over.
        yield* stopAndWipeNode;
        yield* saveConfig((value) => ({
          ...value,
          enrolled: true,
          signedIn: false,
          hostname: input.hostname,
          tags: [...input.tags],
          serveEnabled: true,
          requireOwner: input.tags.length === 0,
        })).pipe(
          Effect.tapError((error) =>
            previous.enrolled
              ? setRuntime({ _tag: "Failed", message: error.message })
              : Effect.void,
          ),
        );
        pendingAuthKey = input.authKey;
        yield* settleLogin(SIGN_IN_REPLACED);
        const attempt = yield* beginLogin;
        yield* startSupervisor;
        return attempt;
      }),
    );
    return yield* awaitLogin(waiter);
  });

  const reauthenticate = Effect.gen(function* () {
    const waiter = yield* transition(
      Effect.gen(function* () {
        const current = readState();
        if (!current.config.enrolled) return yield* new TailnetError({ reason: "not-signed-in" });
        const phase = phaseOf(current);
        if (phase === "running" || phase === "needs-approval") return undefined;
        if (attached === undefined || current.runtime._tag !== "Connected") {
          yield* ensureAvailable;
          const attempt = yield* beginLogin;
          yield* restartSupervisor;
          return attempt;
        }
        const attempt = yield* beginLogin;
        yield* sendCommand({ type: "login" });
        return attempt;
      }),
    );
    return waiter === undefined ? { loginUrl: null } : yield* awaitLogin(waiter);
  }).pipe(Effect.withSpan("TailnetNode.reauthenticate"));

  const cancelSignIn = transition(
    Effect.gen(function* () {
      const { config: current } = readState();
      if (!current.enrolled) return;
      if (current.signedIn) {
        return yield* new TailnetError({
          reason: "rejected",
          detail: "This environment is already signed in to Tailscale. Sign out instead.",
        });
      }
      yield* unenroll;
      yield* settleLogin(SIGN_IN_CANCELLED);
      yield* stopAndWipeNode;
    }),
  ).pipe(Effect.withSpan("TailnetNode.cancelSignIn"));

  const signOut = transition(
    Effect.gen(function* () {
      if (!readState().config.enrolled) return yield* new TailnetError({ reason: "not-signed-in" });
      yield* unenroll;
      yield* settleLogin(SIGN_IN_CANCELLED);
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
    }),
  ).pipe(Effect.withSpan("TailnetNode.signOut"));

  const configure = Effect.fn("TailnetNode.configure")(function* (input: TailnetConfigureInput) {
    yield* transition(
      Effect.gen(function* () {
        yield* saveConfig((value) => ({
          ...value,
          ...(input.serveEnabled === undefined ? {} : { serveEnabled: input.serveEnabled }),
          ...(input.requireOwner === undefined ? {} : { requireOwner: input.requireOwner }),
          ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
          ...(input.loggingAllowed === undefined ? {} : { loggingAllowed: input.loggingAllowed }),
        }));
        yield* recheckConnections;
        if (input.serveEnabled !== undefined) {
          yield* sendCommand({ type: "setServe", enabled: input.serveEnabled });
        }
        if (input.hostname !== undefined) {
          yield* sendCommand({ type: "setHostname", hostname: input.hostname });
        }
        if (
          input.loggingAllowed !== undefined &&
          input.loggingAllowed !== launchedLoggingAllowed &&
          supervisor !== undefined
        ) {
          yield* restartSupervisor;
        }
      }),
    );
  });

  const start = Effect.gen(function* () {
    const current = readState();
    if (!current.config.enrolled || current.runtime._tag === "Unavailable") return;
    if (supervisor === undefined) yield* startSupervisor;
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
