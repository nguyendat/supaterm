import * as HostProcess from "@supaterm/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class TailnetBinaryUnsupported extends Schema.TaggedError<TailnetBinaryUnsupported>()(
  "TailnetBinaryUnsupported",
  {
    platform: Schema.String,
    architecture: Schema.String,
  },
) {
  override get message(): string {
    return `Built-in Tailscale is not supported on ${this.platform}/${this.architecture}.`;
  }
}

class TailnetBinaryNotFound extends Schema.TaggedError<TailnetBinaryNotFound>()(
  "TailnetBinaryNotFound",
  {
    platform: Schema.String,
    architecture: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return "The built-in Tailscale helper is missing. Run `vp run build:tailnet` to build it.";
  }
}

class TailnetBinaryNotExecutable extends Schema.TaggedError<TailnetBinaryNotExecutable>()(
  "TailnetBinaryNotExecutable",
  {
    path: Schema.String,
    mode: Schema.Number,
  },
) {
  override get message(): string {
    return `The built-in Tailscale helper at '${this.path}' is not executable.`;
  }
}

type TailnetBinaryError =
  | TailnetBinaryUnsupported
  | TailnetBinaryNotFound
  | TailnetBinaryNotExecutable;

export interface TailnetLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export class TailnetBinary extends Context.Service<
  TailnetBinary,
  {
    readonly resolve: Effect.Effect<TailnetLaunch, TailnetBinaryError>;
  }
>()("supaterm/tailnet/TailnetBinary") {}

const platformKey = (platform: NodeJS.Platform, architecture: NodeJS.Architecture) =>
  (platform === "darwin" || platform === "linux" || platform === "win32") &&
  (architecture === "arm64" || architecture === "x64")
    ? `${platform}-${architecture}`
    : undefined;

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const executable = platform === "win32" ? "supaterm-tailnet.exe" : "supaterm-tailnet";
  const key = platformKey(platform, architecture);
  const override = environment.SUPATERM_TAILNET_PATH?.trim();
  const bundled =
    key === undefined
      ? []
      : [
          path.resolve(import.meta.dirname, "tailnet", key, executable),
          path.resolve(import.meta.dirname, "tailnet", executable),
          path.resolve(import.meta.dirname, "../tailnet", executable),
          path.resolve(import.meta.dirname, "../../../../native/tailnet/dist", key, executable),
          path.resolve(import.meta.dirname, "../../../native/tailnet/dist", key, executable),
        ];
  const candidates = override ? [override, ...bundled] : bundled;
  if (candidates.length === 0) {
    return TailnetBinary.of({
      resolve: Effect.fail(new TailnetBinaryUnsupported({ platform, architecture })),
    });
  }

  const resolve = Effect.gen(function* () {
    for (const candidate of candidates) {
      const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
      if (Option.isNone(stat)) continue;
      // Directories pass the exec-bit test on win32 and would only fail at spawn.
      if (
        stat.value.type === "Directory" ||
        (platform !== "win32" && (stat.value.mode & 0o111) === 0)
      ) {
        return yield* new TailnetBinaryNotExecutable({ path: candidate, mode: stat.value.mode });
      }
      return { command: candidate, args: [] } satisfies TailnetLaunch;
    }
    return yield* new TailnetBinaryNotFound({ platform, architecture, candidates });
  });

  return TailnetBinary.of({ resolve });
});

export const layer = Layer.effect(TailnetBinary, make);
