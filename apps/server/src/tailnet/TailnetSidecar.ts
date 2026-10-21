import { TailnetHttpsState } from "@supaterm/contracts";
import * as HostProcess from "@supaterm/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as Ndjson from "effect/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { TailnetLaunch } from "./TailnetBinary.ts";

const PROTOCOL_VERSION = 1;
const SHUTDOWN_GRACE = Duration.seconds(3);
const MAX_LOGGED_LINE_LENGTH = 2_000;

/**
 * tsnet reads `TS_*` variables for control URLs, client secrets, and forced logins, so the
 * sidecar only inherits what it needs to find its home, temp space, proxies, and CAs.
 */
const INHERITED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "windir",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const BackendState = Schema.Literals([
  "NoState",
  "NeedsLogin",
  "NeedsMachineAuth",
  "Stopped",
  "Starting",
  "Running",
]);
const isBackendState = Schema.is(BackendState);

/** Mirrors `statusMsg` in `native/tailnet/protocol.go`; `omitempty` fields are optional keys. */
const TailnetSidecarWireStatus = Schema.Struct({
  v: Schema.Literal(PROTOCOL_VERSION),
  type: Schema.Literal("status"),
  backendState: Schema.String,
  authUrl: Schema.optionalKey(Schema.String),
  errMessage: Schema.optionalKey(Schema.String),
  self: Schema.optionalKey(
    Schema.Struct({
      dnsName: Schema.String,
      ipv4: Schema.optionalKey(Schema.String),
      ipv6: Schema.optionalKey(Schema.String),
      userId: Schema.String,
      loginName: Schema.String,
      displayName: Schema.String,
      tagged: Schema.Boolean,
      tags: Schema.Array(Schema.String),
      keyExpiry: Schema.optionalKey(Schema.String),
    }),
  ),
  https: TailnetHttpsState,
  httpsMessage: Schema.optionalKey(Schema.String),
  listening: Schema.Struct({
    https: Schema.optionalKey(Schema.String),
    http: Schema.optionalKey(Schema.String),
  }),
  loggingRequired: Schema.Boolean,
  health: Schema.Array(Schema.String),
});

const TailnetSidecarWireEvent = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(PROTOCOL_VERSION),
    type: Schema.Literal("hello"),
    version: Schema.String,
    tailscaleVersion: Schema.String,
  }),
  TailnetSidecarWireStatus,
  Schema.Struct({
    v: Schema.Literal(PROTOCOL_VERSION),
    type: Schema.Literal("loggedOut"),
    confirmed: Schema.Boolean,
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    v: Schema.Literal(PROTOCOL_VERSION),
    type: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
    fatal: Schema.Boolean,
  }),
]);

// Go writes the profile fields even when empty, and a state from a newer helper reads as
// starting instead of failing the whole event stream.
const normalizeStatus = ({
  self,
  backendState,
  ...status
}: typeof TailnetSidecarWireStatus.Type) => ({
  ...status,
  backendState: isBackendState(backendState) ? backendState : ("Starting" as const),
  ...(self === undefined
    ? {}
    : {
        self: {
          ...Struct.omit(self, ["dnsName", "loginName", "displayName"]),
          ...(self.dnsName === "" ? {} : { dnsName: self.dnsName }),
          ...(self.loginName === "" ? {} : { loginName: self.loginName }),
          ...(self.displayName === "" ? {} : { displayName: self.displayName }),
        },
      }),
});
export type TailnetSidecarStatus = ReturnType<typeof normalizeStatus>;
export type TailnetSidecarEvent =
  | Exclude<typeof TailnetSidecarWireEvent.Type, { readonly type: "status" }>
  | TailnetSidecarStatus;

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(["hello", "status", "loggedOut", "error"]);
const EventEnvelope = Schema.Struct({ v: Schema.Number, type: Schema.String });
const decodeEnvelope = Schema.decodeUnknownEffect(EventEnvelope);
const decodeEvent = Schema.decodeUnknownEffect(TailnetSidecarWireEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export type TailnetSidecarCommand =
  | {
      readonly type: "configure";
      readonly dir: string;
      readonly hostname: string;
      readonly tags: ReadonlyArray<string>;
      readonly serve: boolean;
      readonly allowLogging: boolean;
      readonly ingress: { readonly address: string; readonly secret: string };
      readonly authKey?: string;
    }
  | { readonly type: "login" }
  | { readonly type: "setServe"; readonly enabled: boolean }
  | { readonly type: "setHostname"; readonly hostname: string }
  | { readonly type: "logout" }
  | { readonly type: "shutdown" };

class TailnetSidecarError extends Schema.TaggedError<TailnetSidecarError>()("TailnetSidecarError", {
  stage: Schema.Literals(["spawn", "write", "read", "protocol", "exit"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    switch (this.stage) {
      case "spawn":
        return "The built-in Tailscale helper could not start.";
      case "write":
        return "Could not send a command to the built-in Tailscale helper.";
      case "read":
        return "Could not read from the built-in Tailscale helper.";
      case "protocol":
        return "The built-in Tailscale helper speaks a different protocol version.";
      case "exit":
        return "The built-in Tailscale helper stopped unexpectedly.";
    }
  }
}

export interface TailnetSidecarProcess {
  readonly send: (command: TailnetSidecarCommand) => Effect.Effect<void, TailnetSidecarError>;
  /** Single-use: ends when the helper closes stdout. */
  readonly events: Stream.Stream<TailnetSidecarEvent, TailnetSidecarError>;
  readonly exitCode: Effect.Effect<number, TailnetSidecarError>;
}

export class TailnetSidecar extends Context.Service<
  TailnetSidecar,
  {
    /** Closing the scope asks the helper to shut down, then kills it after a grace period. */
    readonly spawn: (
      launch: TailnetLaunch,
    ) => Effect.Effect<TailnetSidecarProcess, TailnetSidecarError, Scope.Scope>;
  }
>()("supaterm/tailnet/TailnetSidecar") {}

const redactLine = (line: string) =>
  line
    .slice(0, MAX_LOGGED_LINE_LENGTH)
    .replace(/https?:\/\/\S+\/a\/\S+/gu, "[login url]")
    .replace(/tskey-\S+/gu, "[auth key]");

// Per-line work for a long-lived stream; the spawn span already covers the process.
const decodeLine = Effect.fnUntraced(function* (value: unknown, unknownStates: Set<string>) {
  const envelope = yield* decodeEnvelope(value).pipe(
    Effect.mapError((cause) => new TailnetSidecarError({ stage: "read", cause })),
  );
  if (envelope.v !== PROTOCOL_VERSION) {
    return yield* new TailnetSidecarError({ stage: "protocol", cause: envelope.v });
  }
  if (!KNOWN_EVENT_TYPES.has(envelope.type)) return undefined;
  const event = yield* decodeEvent(value).pipe(
    Effect.mapError((cause) => new TailnetSidecarError({ stage: "read", cause })),
  );
  if (event.type !== "status") return event;
  if (!isBackendState(event.backendState) && !unknownStates.has(event.backendState)) {
    unknownStates.add(event.backendState);
    yield* Effect.logWarning("Built-in Tailscale reported an unknown backend state", {
      backendState: event.backendState.slice(0, 64),
    });
  }
  return normalizeStatus(event);
});

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostEnvironment = yield* HostProcess.Environment;
  const env = Object.fromEntries(
    INHERITED_ENVIRONMENT.flatMap((name) => {
      const value = hostEnvironment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

  const spawn = Effect.fn("TailnetSidecar.spawn")(function* (launch: TailnetLaunch) {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(launch.command, [...launch.args], {
          env,
          extendEnv: false,
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(2),
        }),
      )
      .pipe(Effect.mapError((cause) => new TailnetSidecarError({ stage: "spawn", cause })));
    const writeLock = yield* Semaphore.make(1);
    const send = (command: TailnetSidecarCommand) =>
      encodeCommand({ v: PROTOCOL_VERSION, ...command }).pipe(
        Effect.flatMap((line) =>
          Stream.run(Stream.encodeText(Stream.make(`${line}\n`)), handle.stdin).pipe(
            writeLock.withPermit,
          ),
        ),
        Effect.mapError((cause) => new TailnetSidecarError({ stage: "write", cause })),
      );
    const exitCode = handle.exitCode.pipe(
      Effect.map(Number),
      Effect.mapError((cause) => new TailnetSidecarError({ stage: "exit", cause })),
    );

    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.logDebug(redactLine(line)).pipe(Effect.annotateLogs({ scope: "tailnet-sidecar" })),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    // Runs before the spawner's own release, which kills whatever is still running.
    yield* Effect.addFinalizer(() =>
      send({ type: "shutdown" }).pipe(
        Effect.andThen(exitCode),
        Effect.timeout(SHUTDOWN_GRACE),
        Effect.ignore,
      ),
    );

    const unknownStates = new Set<string>();
    const events = handle.stdout.pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.mapError((cause) => new TailnetSidecarError({ stage: "read", cause })),
      Stream.mapEffect((value) => decodeLine(value, unknownStates)),
      Stream.filter((event): event is TailnetSidecarEvent => event !== undefined),
    );

    return { send, events, exitCode } satisfies TailnetSidecarProcess;
  });

  return TailnetSidecar.of({ spawn });
});

export const layer = Layer.effect(TailnetSidecar, make);
