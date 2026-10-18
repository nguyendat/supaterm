import type {
  AdvertisedEndpoint,
  DesktopEmbeddedTailscaleSignInInput,
  DesktopEmbeddedTailscaleStatus,
  DesktopEmbeddedTailscaleState,
} from "@supaterm/contracts";
import { createAdvertisedEndpoint } from "@supaterm/shared/advertisedEndpoint";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The embedded helper is a long-lived process with a JSON-lines control channel.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const DEFAULT_STATUS: DesktopEmbeddedTailscaleStatus = {
  state: "signed-out",
  authUrl: null,
  hostname: null,
  dnsName: null,
  endpointUrl: null,
  ownerLoginName: null,
  tailscaleIps: [],
  serveEnabled: false,
  limitToAccount: true,
  error: null,
};

const EMBEDDED_TAILSCALE_PROVIDER = {
  id: "tailscale-embedded",
  label: "Tailscale",
  kind: "private-network" as const,
  isAddon: true,
};

const sanitizeHostname = (value: string): string => {
  const suffix = "-supaterm";
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (normalized.endsWith(suffix)) {
    const base = normalized.slice(0, -suffix.length).slice(0, 63 - suffix.length);
    return `${base.replace(/-+$/gu, "") || "supaterm"}${suffix}`;
  }
  const base = (normalized || "supaterm").slice(0, 63 - suffix.length).replace(/-+$/gu, "");
  return `${base || "supaterm"}${suffix}`;
};

const normalizeTags = (tags: readonly string[]): readonly string[] => [
  ...new Set(
    tags.flatMap((tag) => {
      const normalized = tag.trim();
      return normalized.length > 0 ? [normalized] : [];
    }),
  ),
];

const HelperJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeHelperJson = Schema.decodeUnknownOption(HelperJson);
const encodeHelperJson = Schema.encodeSync(HelperJson);

const statusFromHelperEvent = (
  event: Record<string, unknown>,
  current: DesktopEmbeddedTailscaleStatus,
): DesktopEmbeddedTailscaleStatus => {
  const type = typeof event.type === "string" ? event.type : "";
  const helperState = typeof event.state === "string" ? event.state : null;
  let state: DesktopEmbeddedTailscaleState = current.state;
  if (type === "running" || helperState === "Running") {
    state = "running";
  } else if (
    type === "auth-url" ||
    helperState === "NeedsLogin" ||
    helperState === "NeedsMachineAuth" ||
    helperState?.startsWith("Needs") === true
  ) {
    state = "needs-login";
  } else if (type === "error") {
    state = "error";
  } else if (helperState === "Starting" || helperState === "NoState") {
    state = "starting";
  } else if (helperState === "Stopped") {
    state = "error";
  } else if (helperState !== null) {
    state = "starting";
  } else if (current.state === "signed-out") {
    state = "starting";
  }
  const dnsName =
    typeof event.dnsName === "string" && event.dnsName.length > 0 ? event.dnsName : current.dnsName;
  let endpointUrl = current.endpointUrl;
  if (typeof event.url === "string" && event.url.length > 0) {
    endpointUrl = event.url;
  } else if (dnsName !== null) {
    endpointUrl = `https://${dnsName}`;
  }
  const error =
    type === "error" && typeof event.message === "string"
      ? event.message
      : state === "running" || state === "needs-login"
        ? null
        : current.error;
  return {
    state,
    authUrl:
      typeof event.authUrl === "string" && event.authUrl.length > 0
        ? event.authUrl
        : current.authUrl,
    hostname:
      typeof event.hostname === "string" && event.hostname.length > 0
        ? event.hostname
        : current.hostname,
    dnsName,
    endpointUrl: state === "running" ? endpointUrl : null,
    ownerLoginName:
      typeof event.ownerLoginName === "string" && event.ownerLoginName.length > 0
        ? event.ownerLoginName
        : current.ownerLoginName,
    tailscaleIps: Array.isArray(event.tailscaleIps)
      ? event.tailscaleIps.filter((value): value is string => typeof value === "string")
      : current.tailscaleIps,
    serveEnabled: typeof event.enabled === "boolean" ? event.enabled : current.serveEnabled,
    limitToAccount: true,
    error,
  };
};

export class DesktopEmbeddedTailscaleUnavailableError extends Schema.TaggedError<DesktopEmbeddedTailscaleUnavailableError>()(
  "DesktopEmbeddedTailscaleUnavailableError",
  { binaryPath: Schema.String },
) {
  override get message(): string {
    return `Embedded Tailscale is unavailable because its helper is missing at ${this.binaryPath}.`;
  }
}

export class DesktopEmbeddedTailscaleProcessError extends Schema.TaggedError<DesktopEmbeddedTailscaleProcessError>()(
  "DesktopEmbeddedTailscaleProcessError",
  { message: Schema.String },
) {}

const writeHelperCommand = (
  input: NodeJS.WritableStream,
  command: Record<string, unknown>,
): Effect.Effect<void, DesktopEmbeddedTailscaleProcessError> =>
  Effect.try({
    try: () => {
      input.write(`${encodeHelperJson(command)}\n`);
    },
    catch: (cause) => new DesktopEmbeddedTailscaleProcessError({ message: String(cause) }),
  });

export class DesktopEmbeddedTailscale extends Context.Service<
  DesktopEmbeddedTailscale,
  {
    readonly getStatus: Effect.Effect<DesktopEmbeddedTailscaleStatus>;
    readonly configureFromSettings: (input: {
      readonly port: number;
    }) => Effect.Effect<
      void,
      DesktopEmbeddedTailscaleProcessError | DesktopEmbeddedTailscaleUnavailableError
    >;
    readonly signIn: (
      input: DesktopEmbeddedTailscaleSignInInput,
      port: number,
    ) => Effect.Effect<
      DesktopEmbeddedTailscaleStatus,
      DesktopEmbeddedTailscaleProcessError | DesktopEmbeddedTailscaleUnavailableError
    >;
    readonly setServeEnabled: (
      enabled: boolean,
    ) => Effect.Effect<DesktopEmbeddedTailscaleStatus, DesktopEmbeddedTailscaleProcessError>;
    readonly signOut: Effect.Effect<
      DesktopEmbeddedTailscaleStatus,
      DesktopEmbeddedTailscaleProcessError
    >;
    readonly getAdvertisedEndpoint: Effect.Effect<AdvertisedEndpoint | null>;
  }
>()("@supaterm/desktop/backend/DesktopEmbeddedTailscale") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const persistEmbeddedTailscale = settings.setEmbeddedTailscale;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statusRef = yield* Ref.make<DesktopEmbeddedTailscaleStatus>(DEFAULT_STATUS);
  const lifecyclePermit = yield* Semaphore.make(1);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  let childInput: NodeJS.WritableStream | null = null;
  let childGeneration = 0;

  const helperName =
    environment.platform === "win32"
      ? "supaterm-tailscale-embedded.exe"
      : "supaterm-tailscale-embedded";
  const stateDir = path.join(environment.stateDir, "tailscale-embedded");
  const binaryCandidates = environment.isPackaged
    ? [path.join(environment.resourcesPath, "tailscale-embedded", helperName)]
    : [
        path.join(environment.rootDir, "native/tailscale-embedded/target/release", helperName),
        path.join(environment.rootDir, "native/tailscale-embedded/target/debug", helperName),
      ];

  const findBinary = Effect.gen(function* () {
    for (const candidate of binaryCandidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    return null;
  });

  const stopChild = Effect.promise(() => {
    childGeneration += 1;
    const currentChild = child;
    const currentInput = childInput;
    child = null;
    childInput = null;
    if (currentChild === null) return Promise.resolve();
    if (currentChild.exitCode !== null || currentChild.signalCode !== null) {
      return Promise.resolve();
    }
    try {
      currentInput?.write(`${encodeHelperJson({ type: "stop" })}\n`);
    } catch {}
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      currentChild.once("close", finish);
      if (currentChild.exitCode !== null || currentChild.signalCode !== null) {
        finish();
        return;
      }
      try {
        currentChild.kill();
      } catch {
        finish();
      }
    });
  });

  const startChild = Effect.fn("desktop.embeddedTailscale.startChild")(function* (input: {
    readonly hostname: string;
    readonly tags: readonly string[];
    readonly port: number;
    readonly serveEnabled: boolean;
  }) {
    const binaryPath = yield* findBinary;
    if (binaryPath === null) {
      return yield* new DesktopEmbeddedTailscaleUnavailableError({
        binaryPath: binaryCandidates[0]!,
      });
    }
    yield* stopChild;
    childGeneration += 1;
    const generation = childGeneration;
    yield* fileSystem
      .makeDirectory(stateDir, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new DesktopEmbeddedTailscaleProcessError({ message: String(cause) }),
        ),
      );
    const spawned = NodeChildProcess.spawn(
      binaryPath,
      [
        "--hostname",
        input.hostname,
        "--state-dir",
        stateDir,
        "--backend-url",
        `http://127.0.0.1:${input.port}`,
        "--tags",
        input.tags.join(","),
        "--serve",
        String(input.serveEnabled),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child = spawned;
    childInput = spawned.stdin;
    yield* Ref.set(statusRef, {
      ...DEFAULT_STATUS,
      state: "starting",
      hostname: input.hostname,
      serveEnabled: input.serveEnabled,
    });
    const output = NodeReadline.createInterface({ input: spawned.stdout });
    output.on("line", (line) => {
      try {
        const event = Option.getOrNull(decodeHelperJson(line));
        if (event !== null) {
          void runPromise(
            Ref.update(statusRef, (current) =>
              generation === childGeneration ? statusFromHelperEvent(event, current) : current,
            ),
          );
        }
      } catch {}
    });
    spawned.stdin.on("error", (error) => {
      void runPromise(
        Ref.update(statusRef, (current) =>
          generation === childGeneration
            ? { ...current, state: "error" as const, error: error.message }
            : current,
        ),
      );
    });
    spawned.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message.length > 0) {
        void runPromise(
          Ref.update(statusRef, (current) =>
            generation === childGeneration
              ? { ...current, state: "error" as const, error: message }
              : current,
          ),
        );
      }
    });
    spawned.on("error", (error) => {
      void runPromise(
        Ref.update(statusRef, (current) =>
          generation === childGeneration
            ? { ...current, state: "error" as const, error: error.message }
            : current,
        ),
      );
    });
    spawned.once("exit", () => {
      void runPromise(
        Ref.update(statusRef, (current) => {
          if (generation !== childGeneration) return current;
          child = null;
          childInput = null;
          return current.state === "signed-out"
            ? current
            : { ...current, state: "error" as const, error: "Embedded Tailscale stopped." };
        }),
      );
    });
  });
  const startChildAndRecordError = (input: Parameters<typeof startChild>[0]) =>
    startChild(input).pipe(
      Effect.tapError((error) =>
        Ref.update(statusRef, (current) => ({
          ...current,
          state: "error" as const,
          hostname: input.hostname,
          error: error.message,
        })),
      ),
    );

  const getStatus = Ref.get(statusRef);
  const configureFromSettings = Effect.fn("desktop.embeddedTailscale.configureFromSettings")(
    function* ({ port }: { readonly port: number }) {
      const current = yield* settings.get;
      if (!current.embeddedTailscaleEnabled) return;
      const hostname = sanitizeHostname(current.embeddedTailscaleHostname ?? NodeOS.hostname());
      yield* startChildAndRecordError({
        hostname,
        tags: normalizeTags(current.embeddedTailscaleTags),
        port,
        serveEnabled: current.embeddedTailscaleServeEnabled !== false,
      });
    },
    lifecyclePermit.withPermit,
  );

  const signIn = Effect.fn("desktop.embeddedTailscale.signIn")(function* (
    input: DesktopEmbeddedTailscaleSignInInput,
    port: number,
  ) {
    const hostname = sanitizeHostname(input.hostname || NodeOS.hostname());
    const tags = normalizeTags(input.tags);
    yield* startChildAndRecordError({ hostname, tags, port, serveEnabled: true });
    yield* persistEmbeddedTailscale({ enabled: true, hostname, tags, serveEnabled: true }).pipe(
      Effect.mapError(
        (cause) => new DesktopEmbeddedTailscaleProcessError({ message: cause.message }),
      ),
      Effect.tapError(() => stopChild),
    );
    return yield* getStatus;
  }, lifecyclePermit.withPermit);

  const setServeEnabled = Effect.fn("desktop.embeddedTailscale.setServeEnabled")(function* (
    enabled: boolean,
  ) {
    const input = childInput;
    if (input === null) {
      return yield* new DesktopEmbeddedTailscaleProcessError({
        message: "Embedded Tailscale is not running.",
      });
    }
    const previousEnabled = (yield* getStatus).serveEnabled;
    yield* writeHelperCommand(input, { type: "serve", enabled });
    yield* persistEmbeddedTailscale({ serveEnabled: enabled, enabled: true }).pipe(
      Effect.mapError(
        (cause) => new DesktopEmbeddedTailscaleProcessError({ message: cause.message }),
      ),
      Effect.tapError(() =>
        childInput === input
          ? writeHelperCommand(input, { type: "serve", enabled: previousEnabled }).pipe(
              Effect.ignore,
            )
          : Effect.void,
      ),
    );
    yield* Ref.update(statusRef, (current) => ({ ...current, serveEnabled: enabled }));
    return yield* getStatus;
  }, lifecyclePermit.withPermit);

  const signOut = Effect.gen(function* () {
    yield* persistEmbeddedTailscale({
      enabled: false,
      hostname: null,
      tags: [],
      serveEnabled: true,
    }).pipe(
      Effect.mapError(
        (cause) => new DesktopEmbeddedTailscaleProcessError({ message: cause.message }),
      ),
    );
    yield* stopChild;
    yield* fileSystem.remove(stateDir, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* Ref.set(statusRef, DEFAULT_STATUS);
    return DEFAULT_STATUS;
  }).pipe(lifecyclePermit.withPermit);

  const getAdvertisedEndpoint = getStatus.pipe(
    Effect.map((status) => {
      if (status.endpointUrl === null) return null;
      const available = status.state === "running" && status.serveEnabled;
      return createAdvertisedEndpoint({
        id: `tailscale-embedded:${status.endpointUrl}`,
        label: "Tailscale HTTPS",
        provider: EMBEDDED_TAILSCALE_PROVIDER,
        source: "desktop-addon",
        httpBaseUrl: status.endpointUrl,
        reachability: "private-network",
        hostedHttpsCompatibility: available ? "compatible" : "requires-configuration",
        status: available ? "available" : "unavailable",
        description: available
          ? "Supaterm over your tailnet; local network access is not required."
          : "Tailscale hostname. Turn on the embedded Tailscale endpoint to connect.",
      });
    }),
  );

  yield* Effect.addFinalizer(() => stopChild);

  return DesktopEmbeddedTailscale.of({
    getStatus,
    configureFromSettings,
    signIn,
    setServeEnabled,
    signOut,
    getAdvertisedEndpoint,
  });
});

export const layer = Layer.effect(DesktopEmbeddedTailscale, make);
