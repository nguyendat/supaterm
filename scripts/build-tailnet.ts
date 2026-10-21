// @effect-diagnostics nodeBuiltinImport:off - runs as a plain Node project script.
/**
 * Builds the supaterm-tailnet sidecar:
 *
 *   node scripts/build-tailnet.ts [--platform darwin|linux|win32] [--arch arm64|x64] [--out <dir>]
 *
 * Defaults to the host platform and arch, writing to
 * native/tailnet/dist/<platform>-<arch>/supaterm-tailnet[.exe].
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const GOOS = { darwin: "darwin", linux: "linux", win32: "windows" } as const;
const GOARCH = { arm64: "arm64", x64: "amd64" } as const;

const isKeyOf = <T extends object>(map: T, key: string): key is Extract<keyof T, string> =>
  Object.hasOwn(map, key);

const { values } = NodeUtil.parseArgs({
  options: {
    // oxlint-disable-next-line supaterm/no-global-process-runtime -- Plain build script with no Effect runtime.
    platform: { type: "string", default: process.platform },
    // oxlint-disable-next-line supaterm/no-global-process-runtime -- Plain build script with no Effect runtime.
    arch: { type: "string", default: process.arch },
    out: { type: "string" },
  },
});
const { platform, arch } = values;
if (!isKeyOf(GOOS, platform)) {
  throw new Error(`Unsupported --platform ${platform}; expected darwin, linux or win32.`);
}
if (!isKeyOf(GOARCH, arch)) {
  throw new Error(`Unsupported --arch ${arch}; expected arm64 or x64.`);
}

const source = NodePath.resolve(import.meta.dirname, "..", "native", "tailnet");
const outDir = NodePath.resolve(values.out ?? NodePath.join(source, "dist", `${platform}-${arch}`));
const binary = NodePath.join(
  outDir,
  platform === "win32" ? "supaterm-tailnet.exe" : "supaterm-tailnet",
);
NodeFS.mkdirSync(outDir, { recursive: true });

const build = NodeChildProcess.spawnSync(
  "go",
  ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "."],
  {
    cwd: source,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: GOOS[platform], GOARCH: GOARCH[arch] },
  },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
process.stdout.write(`${binary}\n`);
