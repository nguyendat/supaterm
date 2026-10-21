import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@supaterm/shared/HostProcess";

import {
  buildTailscaleHttpsBaseUrl,
  clearTailscaleServePort,
  disableTailscaleServe,
  ensureTailscaleServe,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  parseTailscaleSshEnabled,
  parseTailscaleStatus,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  TAILSCALE_STATUS_TIMEOUT,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleCommandTimeoutError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    // `message` and `cause` are getters on Error subclasses, so they are not
    // own enumerable properties and Object.entries alone would skip them.
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };

  walk(error, "error");
}
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;
const tailscaleStatusWithSingleIpJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.90.1.2"]}}`;

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function neverFinishingMockHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// The executable name depends on the host platform (`tailscale.exe` on
// Windows), so pin it: these tests assert the posix spelling.
function layerSpawner(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcess.Platform, "linux"),
  );
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return layerSpawner(
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

describe("tailscale", () => {
  it.effect("detects Tailnet IPv4 addresses", () =>
    Effect.sync(() => {
      assert.equal(isTailscaleIpv4Address("100.64.0.1"), true);
      assert.equal(isTailscaleIpv4Address("100.127.255.254"), true);
      assert.equal(isTailscaleIpv4Address("100.128.0.1"), false);
      assert.equal(isTailscaleIpv4Address("192.168.1.44"), false);
    }),
  );

  it.effect("parses MagicDNS names from tailscale status", () =>
    Effect.gen(function* () {
      const dnsName = yield* parseTailscaleMagicDnsName(tailscaleStatusJson);
      assert.equal(dnsName, "desktop.tail.ts.net");
      assert.equal(yield* parseTailscaleMagicDnsName("{}"), null);
    }),
  );

  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
        httpsServeEnabled: null,
      });
    }),
  );

  it.effect("reads the HTTPS serve capability from the status capability map", () =>
    Effect.gen(function* () {
      const enabled = yield* parseTailscaleStatus(
        `{"Self":{"CapMap":{"https":null,"funnel":null}}}`,
      );
      assert.equal(enabled.httpsServeEnabled, true);

      const disabled = yield* parseTailscaleStatus(`{"Self":{"CapMap":{"funnel":null}}}`);
      assert.equal(disabled.httpsServeEnabled, false);
    }),
  );

  it.effect("preserves status decoding failures without exposing cause text", () =>
    Effect.gen(function* () {
      const error = yield* parseTailscaleStatus("{not-json").pipe(Effect.flip);

      assert.instanceOf(error, TailscaleStatusParseError);
      assert.equal(error.message, "Failed to decode tailscale status JSON.");
      assert.isDefined(error.cause);
      assert.notInclude(error.message, String(error.cause));
    }),
  );

  it.effect("reads Tailscale SSH enablement from local prefs", () => {
    const prefsJson =
      '{\n\t"ControlURL": "https://controlplane.tailscale.com",\n\t"RunSSH": true,\n\t"WantRunning": true\n}\n';
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["debug", "prefs"]);
      return { stdout: prefsJson };
    });

    return Effect.gen(function* () {
      assert.isTrue(yield* readTailscaleSshEnabled.pipe(Effect.provide(layer)));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":false,"WantRunning":true}'));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":true,"WantRunning":false}'));
      assert.isFalse(yield* parseTailscaleSshEnabled("{}"));
      const error = yield* parseTailscaleSshEnabled("{not-json").pipe(Effect.flip);
      assert.instanceOf(error, TailscaleStatusParseError);
    });
  });

  it.effect("builds clean HTTPS base URLs", () =>
    Effect.sync(() => {
      assert.equal(
        buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net" }),
        "https://desktop.tail.ts.net/",
      );
      assert.equal(
        buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net", servePort: 8443 }),
        "https://desktop.tail.ts.net:8443/",
      );
    }),
  );

  it.effect("reads tailscale status through the process spawner service", () => {
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["status", "--json"]);
      return {
        stdout: tailscaleStatusWithSingleIpJson,
      };
    });

    return Effect.gen(function* () {
      const status = yield* readTailscaleStatus.pipe(Effect.provide(layer));
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.90.1.2"],
        httpsServeEnabled: null,
      });
    });
  });

  it.effect("preserves tailscale spawn failures as causes", () => {
    const systemCause = new Error("private executable lookup detail");
    const cause = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      cause: systemCause,
    });
    const layer = layerSpawner(ChildProcessSpawner.make(() => Effect.fail(cause)));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandSpawnError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Failed to spawn tailscale status.");
      assert.notInclude(error.message, systemCause.message);
    });
  });

  it.effect("turns spawn defects into typed spawn failures", () => {
    // A non-directory entry on PATH makes node's spawn throw ENOTDIR
    // synchronously. The platform spawner calls `NodeChildProcess.spawn` from
    // inside an `Effect.callback` registration, so that throw arrives as a
    // defect rather than a typed error - the shape reproduced here.
    const defect = Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" });
    const layer = layerSpawner(
      ChildProcessSpawner.make(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      ),
    );

    return Effect.gen(function* () {
      const statusError = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(statusError, TailscaleCommandSpawnError);
      assert.equal(statusError.subcommand, "status");
      assert.strictEqual(statusError.cause, defect);

      const serveError = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(serveError, TailscaleCommandSpawnError);
      assert.equal(serveError.subcommand, "serve");
      assert.strictEqual(serveError.cause, defect);

      const degraded = yield* readTailscaleStatus.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provide(layer),
      );
      assert.equal(degraded, null);
    });
  });

  it.effect("keeps nonzero exit diagnostics structured", () => {
    const layer = layerMockSpawner(() => ({
      code: 7,
      stderr: "not logged in tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdoutLength, 0);
      assert.equal(error.stderrLength, 43);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.message, "tailscale status exited with code 7.");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  it.effect("classifies unrecognized stderr without quoting it", () => {
    const layer = layerMockSpawner(() => ({
      code: 3,
      stderr: "something novel went wrong for node fluffy-badger tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.stderrDiagnostic, "unknown");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
      assertCarriesNoSecret(error, "fluffy-badger");
    });
  });

  it.effect("times out tailscale status through TestClock", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      layerSpawner(ChildProcessSpawner.make(() => Effect.succeed(neverFinishingMockHandle()))),
    );

    return Effect.gen(function* () {
      const fiber = yield* readTailscaleStatus.pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(TAILSCALE_STATUS_TIMEOUT);
      const error = yield* Fiber.join(fiber);

      assert.instanceOf(error, TailscaleCommandTimeoutError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.timeoutMs, 3_500);
      assert.isTrue(Cause.isTimeoutError(error.cause));
      assert.equal(error.message, "tailscale status timed out after 3500ms.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("configures tailscale serve through the process spawner service", () => {
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"]);
      return {};
    });

    return ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(Effect.provide(layer));
  });

  it.effect("retains tailscale serve exit diagnostics", () => {
    const layer = layerMockSpawner(() => ({
      code: 1,
      stderr: "serve permission denied tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "serve");
      assert.equal(error.argumentCount, 4);
      assert.equal(error.exitCode, 1);
      assert.equal(error.stderrLength, 53);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.stderrDiagnostic, "permission-denied");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  it.effect("clears every mount on a port through the process spawner service", () => {
    const commands: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }[] = [];
    const layer = layerMockSpawner((command, args) => {
      commands.push({ command, args });
      return {};
    });

    return Effect.gen(function* () {
      yield* clearTailscaleServePort({ servePort: 8443 }).pipe(Effect.provide(layer));
      assert.deepEqual(commands, [
        { command: "tailscale", args: ["serve", "--https=8443", "off"] },
      ]);
    });
  });

  describe("disableTailscaleServe", () => {
    const serveStatus = (web: Record<string, Record<string, { Proxy?: string; Path?: string }>>) =>
      JSON.stringify({
        TCP: { "8443": { HTTPS: true } },
        Web: Object.fromEntries(
          Object.entries(web).map(([hostPort, handlers]) => [hostPort, { Handlers: handlers }]),
        ),
      });

    const runDisable = (
      statusStdout: string,
      input: { readonly localHost?: string } = {},
      offResult: { stderr?: string; code?: number } = {},
    ) => {
      const calls: Array<ReadonlyArray<string>> = [];
      const layer = layerMockSpawner((command, args) => {
        assert.equal(command, "tailscale");
        calls.push(args);
        return args.includes("status") ? { stdout: statusStdout } : offResult;
      });
      return disableTailscaleServe({ localPort: 13773, servePort: 8443, ...input }).pipe(
        Effect.map((result) => ({ result, calls })),
        Effect.provide(layer),
      );
    };

    const statusCall = ["serve", "status", "--json"];
    const offCall = ["serve", "--https=8443", "--set-path=/", "off"];

    it.effect("removes only the root mount when it still proxies to Supaterm", () =>
      Effect.gen(function* () {
        const { result, calls } = yield* runDisable(
          serveStatus({
            "desktop.tail.ts.net:8443": {
              "/": { Proxy: "http://127.0.0.1:13773" },
              "/grafana": { Proxy: "http://127.0.0.1:3000" },
            },
            "desktop.tail.ts.net:443": { "/": { Proxy: "http://127.0.0.1:8080" } },
          }),
        );

        assert.deepEqual(result, { outcome: "removed" });
        assert.deepEqual(calls, [statusCall, offCall]);
      }),
    );

    it.effect("matches the loopback target the way tailscale normalizes it", () =>
      Effect.gen(function* () {
        const ipv6 = yield* runDisable(
          serveStatus({ "desktop.tail.ts.net:8443": { "/": { Proxy: "http://[::1]:13773" } } }),
          { localHost: "[::1]" },
        );
        assert.deepEqual(ipv6.result, { outcome: "removed" });

        const trailingSlash = yield* runDisable(
          serveStatus({
            "desktop.tail.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:13773/" } },
          }),
        );
        assert.deepEqual(trailingSlash.result, { outcome: "removed" });
      }),
    );

    it.effect("leaves a root mount that points somewhere else", () =>
      Effect.gen(function* () {
        for (const handler of [
          { Proxy: "http://127.0.0.1:3000" },
          { Proxy: "http://localhost:13773" },
          { Path: "/srv/www" },
        ]) {
          const { result, calls } = yield* runDisable(
            serveStatus({ "desktop.tail.ts.net:8443": { "/": handler } }),
          );

          assert.deepEqual(result, {
            outcome: "not-owned",
            reason: "other-target",
            manualCommand: "tailscale serve --https=8443 --set-path=/ off",
          });
          assert.deepEqual(calls, [statusCall]);
        }
      }),
    );

    it.effect("leaves the port alone when any name's root mount is not Supaterm's", () =>
      Effect.gen(function* () {
        const { result, calls } = yield* runDisable(
          serveStatus({
            "old-name.tail.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:13773" } },
            "desktop.tail.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:3000" } },
          }),
        );

        assert.equal(result.outcome, "not-owned");
        assert.deepEqual(calls, [statusCall]);
      }),
    );

    it.effect("does nothing when the port has no root mount", () =>
      Effect.gen(function* () {
        for (const statusStdout of [
          "null",
          "{}",
          serveStatus({ "desktop.tail.ts.net:443": { "/": { Proxy: "http://127.0.0.1:13773" } } }),
          serveStatus({
            "desktop.tail.ts.net:8443": { "/grafana": { Proxy: "http://127.0.0.1:3000" } },
          }),
        ]) {
          const { result, calls } = yield* runDisable(statusStdout);
          assert.deepEqual(result, { outcome: "absent" });
          assert.deepEqual(calls, [statusCall]);
        }
      }),
    );

    it.effect("reports unreadable serve status without changing anything", () =>
      Effect.gen(function* () {
        const { result, calls } = yield* runDisable("{not-json");

        assert.deepEqual(result, {
          outcome: "not-owned",
          reason: "unreadable",
          manualCommand: "tailscale serve --https=8443 --set-path=/ off",
        });
        assert.deepEqual(calls, [statusCall]);
      }),
    );

    it.effect("treats a mount removed between status and off as absent", () =>
      Effect.gen(function* () {
        const { result } = yield* runDisable(
          serveStatus({ "desktop.tail.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:13773" } } }),
          {},
          { code: 1, stderr: "error: failed to remove web serve: handler does not exist" },
        );
        assert.deepEqual(result, { outcome: "absent" });
      }),
    );

    it.effect("fails with the command error when serve status cannot run", () => {
      const layer = layerMockSpawner(() => ({ code: 1, stderr: "not logged in" }));

      return Effect.gen(function* () {
        const error = yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
          Effect.flip,
          Effect.provide(layer),
        );

        assert.instanceOf(error, TailscaleCommandExitError);
        assert.equal(error.subcommand, "serve");
        assert.equal(error.stderrDiagnostic, "not-logged-in");
      });
    });
  });
});
