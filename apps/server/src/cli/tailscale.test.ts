// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION, type TailnetStatus } from "@supaterm/contracts";
import * as NetService from "@supaterm/shared/Net";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";
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

it.effect("signs in with an auth key file and waits until the node serves", () =>
  Effect.acquireUseRelease(
    Effect.callback<{ readonly server: NodeHttp.Server; readonly bodies: Array<string> }>(
      (resume) => {
        const bodies: Array<string> = [];
        let signedIn = false;
        const server = NodeHttp.createServer((request, response) => {
          const reply = (body: unknown) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          };
          if (request.url === "/.well-known/supaterm/environment") return reply(descriptor);
          expect(request.headers.authorization).toMatch(/^Bearer /u);
          if (request.url === "/api/tailnet/status") {
            return reply(signedIn ? runningStatus : baseStatus);
          }
          if (request.url === "/api/tailnet/sign-in" && request.method === "POST") {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
              body += chunk;
            });
            request.on("end", () => {
              bodies.push(body);
              signedIn = true;
              reply({ loginUrl: null });
            });
            return;
          }
          response.writeHead(404);
          response.end();
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, bodies })));
      },
    ),
    ({ server, bodies }) =>
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
        const keyFile = NodePath.join(baseDir, "auth-key");
        NodeFS.writeFileSync(keyFile, "tskey-auth-from-file\n");

        yield* Command.runWith(cli, { version: "0.0.0" })([
          "tailscale",
          "login",
          "--base-dir",
          baseDir,
          "--tag",
          "tag:supaterm",
          "--auth-key-file",
          keyFile,
        ]);

        expect(bodies.map((body) => JSON.parse(body))).toEqual([
          {
            hostname: "khoi-abcdefghij-supaterm",
            tags: ["tag:supaterm"],
            authKey: "tskey-auth-from-file",
          },
        ]);
        const output = (yield* TestConsole.logLines).join("\n");
        assert.include(output, "Built-in Tailscale: Running");
        assert.include(output, "HTTPS: https://khoi-abcdefghij-supaterm.tail1234.ts.net/");
        assert.notInclude(output, "tskey-");
      }),
    ({ server }) => Effect.sync(() => server.close()),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer))),
);
