// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION, type TailnetStatus } from "@supaterm/contracts";
import * as NetService from "@supaterm/shared/Net";
import { assert, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";
import { TailnetLoginPollInterval } from "./tailscale.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

const descriptor = {
  environmentId: "tailscale-cli-environment",
  label: "tailscale-cli",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: {},
};

const baseStatus: TailnetStatus = {
  phase: "signed-out",
  suggestedHostname: "khoi-abcdefghij-supaterm",
  tags: [],
  serveEnabled: true,
  requireOwner: true,
  loggingAllowed: false,
  loggingRequired: false,
  https: "pending",
};

const runningStatus: TailnetStatus = {
  ...baseStatus,
  phase: "running",
  hostname: "khoi-abcdefghij-supaterm",
  https: "ready",
  httpsUrl: "https://khoi-abcdefghij-supaterm.tail1234.ts.net/",
  httpUrl: "http://100.64.0.1/",
  self: {
    dnsName: "khoi-abcdefghij-supaterm.tail1234.ts.net",
    loginName: "khoi@github",
    tagged: false,
    tags: [],
  },
};

const LOGIN_URL = "https://login.tailscale.com/a/reauth";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorized: boolean;
  readonly body: string;
}

/** A fake running server: answers discovery itself and every API call through `respond`. */
const withRunningServer = <A, E, R>(
  respond: (request: RecordedRequest) => unknown,
  run: (input: {
    readonly baseDir: string;
    readonly requests: ReadonlyArray<RecordedRequest>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.callback<{
      readonly server: NodeHttp.Server;
      readonly requests: Array<RecordedRequest>;
    }>((resume) => {
      const requests: Array<RecordedRequest> = [];
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const reply = (value: unknown) => {
            if (value === undefined) {
              response.writeHead(404);
              response.end();
              return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(value));
          };
          if (request.url === "/.well-known/supaterm/environment") return reply(descriptor);
          const recorded = {
            method: request.method ?? "GET",
            url: request.url ?? "",
            authorized: (request.headers.authorization ?? "").startsWith("Bearer "),
            body,
          };
          requests.push(recorded);
          reply(respond(recorded));
        });
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, requests })));
    }),
    ({ server, requests }) =>
      Effect.gen(function* () {
        const address = server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die("Expected a TCP address");
        }
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "supaterm-ts-cli-"));
        yield* persistServerRuntimeState({
          path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: address.port,
          }),
        });
        return yield* run({ baseDir, requests });
      }),
    ({ server }) => Effect.sync(() => server.close()),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)));

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const mutations = (requests: ReadonlyArray<RecordedRequest>) =>
  requests.flatMap((request) =>
    request.method === "POST"
      ? [{ url: request.url, body: request.body.length === 0 ? null : JSON.parse(request.body) }]
      : [],
  );

it.effect("signs in with an auth key file and waits until the node serves", () => {
  let signedIn = false;
  return withRunningServer(
    (request) => {
      if (request.url === "/api/tailnet/status") return signedIn ? runningStatus : baseStatus;
      if (request.url === "/api/tailnet/sign-in" && request.method === "POST") {
        signedIn = true;
        return { loginUrl: null };
      }
      return undefined;
    },
    ({ baseDir, requests }) =>
      Effect.gen(function* () {
        const keyFile = NodePath.join(baseDir, "auth-key");
        NodeFS.writeFileSync(keyFile, "tskey-auth-from-file\n");

        yield* runCli([
          "tailscale",
          "login",
          "--base-dir",
          baseDir,
          "--tag",
          "tag:supaterm",
          "--auth-key-file",
          keyFile,
        ]);

        expect(requests.every((request) => request.authorized)).toBe(true);
        expect(mutations(requests)).toEqual([
          {
            url: "/api/tailnet/sign-in",
            body: {
              hostname: "khoi-abcdefghij-supaterm",
              tags: ["tag:supaterm"],
              authKey: "tskey-auth-from-file",
            },
          },
        ]);
        const output = (yield* TestConsole.logLines).join("\n");
        assert.include(output, "Built-in Tailscale: Running");
        assert.include(output, "HTTPS: https://khoi-abcdefghij-supaterm.tail1234.ts.net/");
        assert.notInclude(output, "tskey-");
      }),
  );
});

it.effect("reauthenticates an expired enrollment instead of signing in again", () => {
  let reauthenticated = false;
  return withRunningServer(
    (request) => {
      if (request.url === "/api/tailnet/status") {
        return reauthenticated ? runningStatus : { ...runningStatus, phase: "needs-reauth" };
      }
      if (request.url === "/api/tailnet/reauthenticate" && request.method === "POST") {
        reauthenticated = true;
        return { loginUrl: LOGIN_URL };
      }
      return undefined;
    },
    ({ baseDir, requests }) =>
      Effect.gen(function* () {
        yield* runCli(["tailscale", "login", "--base-dir", baseDir, "--tag", "tag:supaterm"]);

        expect(requests.every((request) => request.authorized)).toBe(true);
        expect(mutations(requests)).toEqual([{ url: "/api/tailnet/reauthenticate", body: null }]);
        const output = (yield* TestConsole.logLines).join("\n");
        assert.include(output, "--tag, and --auth-key-file are ignored");
        assert.include(output, "back in to Tailscale");
        assert.include(output, LOGIN_URL);
        assert.include(output, "Built-in Tailscale: Running");
      }),
  );
});

it.live("waits for a booting node to settle before asking for a login link", () => {
  const phases = ["starting", "needs-login"] as const;
  let reads = 0;
  let reauthenticated = false;
  return withRunningServer(
    (request) => {
      if (request.url === "/api/tailnet/status") {
        if (reauthenticated) return runningStatus;
        const phase = phases[Math.min(reads, phases.length - 1)];
        reads += 1;
        return { ...baseStatus, phase };
      }
      if (request.url === "/api/tailnet/reauthenticate" && request.method === "POST") {
        reauthenticated = true;
        return { loginUrl: LOGIN_URL };
      }
      return undefined;
    },
    ({ baseDir, requests }) =>
      Effect.gen(function* () {
        yield* runCli(["tailscale", "login", "--base-dir", baseDir]).pipe(
          Effect.provideService(TailnetLoginPollInterval, Duration.zero),
        );

        expect(mutations(requests)).toEqual([{ url: "/api/tailnet/reauthenticate", body: null }]);
        const output = (yield* TestConsole.logLines).join("\n");
        assert.include(output, "is starting");
        assert.include(output, LOGIN_URL);
        assert.include(output, "Built-in Tailscale: Running");
      }),
  );
});

it.effect("leaves a signed-in node alone", () =>
  withRunningServer(
    (request) => (request.url === "/api/tailnet/status" ? runningStatus : undefined),
    ({ baseDir, requests }) =>
      Effect.gen(function* () {
        yield* runCli(["tailscale", "login", "--base-dir", baseDir]);

        expect(mutations(requests)).toEqual([]);
        const output = (yield* TestConsole.logLines).join("\n");
        assert.include(output, "is already signed in to Tailscale");
        assert.include(output, "Built-in Tailscale: Running");
      }),
  ),
);
