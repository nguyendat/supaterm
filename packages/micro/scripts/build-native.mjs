import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { include_dir } from "node-api-headers";

// oxlint-disable-next-line supacode/no-global-process-runtime -- This standalone native compiler has no Effect runtime.
if (process.platform === "darwin") {
  const source = NodeURL.fileURLToPath(new URL("../native/topology.cc", import.meta.url));
  const output = NodeURL.fileURLToPath(
    new URL("../../../apps/desktop/dist-electron/micro-hid/topology.node", import.meta.url),
  );
  const script = NodeURL.fileURLToPath(import.meta.url);
  let current = false;
  try {
    current =
      NodeFS.statSync(output).mtimeMs >=
      Math.max(NodeFS.statSync(source).mtimeMs, NodeFS.statSync(script).mtimeMs);
  } catch {}
  if (!current) {
    NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      NodeChildProcess.execFileSync(
        "xcrun",
        [
          "clang++",
          "-std=c++20",
          "-fblocks",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-DNAPI_VERSION=8",
          "-I",
          include_dir,
          "-arch",
          "arm64",
          "-arch",
          "x86_64",
          "-mmacosx-version-min=11.0",
          "-bundle",
          "-undefined",
          "dynamic_lookup",
          "-framework",
          "IOKit",
          "-framework",
          "CoreFoundation",
          source,
          "-o",
          temporary,
        ],
        { stdio: "inherit" },
      );
      NodeFS.renameSync(temporary, output);
    } finally {
      if (NodeFS.existsSync(temporary)) NodeFS.unlinkSync(temporary);
    }
  }
  const directory = NodePath.dirname(output);
  const require = NodeModule.createRequire(import.meta.url);
  const hid = NodePath.dirname(require.resolve("node-hid"));
  for (const arch of ["arm64", "x64"]) {
    const prebuild = `prebuilds/HID-darwin-${arch}/node-napi-v4.node`;
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, prebuild)), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(hid, prebuild), NodePath.join(directory, prebuild));
  }
  const licenses = NodePath.join(directory, "licenses");
  NodeFS.mkdirSync(licenses, { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(hid, "LICENSE-bsd.txt"),
    NodePath.join(licenses, "node-hid.txt"),
  );
  const prebuildsPackage = NodeModule.createRequire(NodePath.join(hid, "nodehid.js")).resolve(
    "pkg-prebuilds/package.json",
  );
  NodeFS.copyFileSync(
    NodePath.join(NodePath.dirname(prebuildsPackage), "LICENSE"),
    NodePath.join(licenses, "pkg-prebuilds.txt"),
  );
}
