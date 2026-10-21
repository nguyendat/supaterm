import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@supaterm/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as TailnetBinary from "./TailnetBinary.ts";

// NTFS never reports POSIX exec bits, so the executable check cannot be exercised there.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const resolveWith = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  Effect.flatMap(TailnetBinary.TailnetBinary, (binary) => binary.resolve).pipe(
    Effect.provide(TailnetBinary.layer),
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Architecture, "x64"),
  );

describe("TailnetBinary", () => {
  it.effect.skipIf(windowsHost)("prefers an executable SUPATERM_TAILNET_PATH", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "supaterm-tn-bin-" });
      const binary = `${directory}/supaterm-tailnet`;
      yield* fileSystem.writeFileString(binary, "binary");
      yield* fileSystem.chmod(binary, 0o755);

      expect(yield* resolveWith({ SUPATERM_TAILNET_PATH: binary }, "linux")).toEqual({
        command: binary,
        args: [],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("refuses a helper that is not executable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "supaterm-tn-bin-" });
      const binary = `${directory}/supaterm-tailnet`;
      yield* fileSystem.writeFileString(binary, "binary");
      yield* fileSystem.chmod(binary, 0o644);

      const error = yield* resolveWith({ SUPATERM_TAILNET_PATH: binary }, "linux").pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("TailnetBinaryNotExecutable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says how to build the helper when none is found", () =>
    Effect.gen(function* () {
      const error = yield* resolveWith(
        { SUPATERM_TAILNET_PATH: "/nonexistent/supaterm-tailnet" },
        "freebsd",
      ).pipe(Effect.flip);
      expect(error._tag).toBe("TailnetBinaryNotFound");
      expect(error.message).toContain("vp run build:tailnet");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
