// @effect-diagnostics nodeBuiltinImport:off -- Exercises the ingress through real local sockets and a raw Node HTTP server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as TailnetIngress from "./TailnetIngress.ts";

const SECRET = "ab".repeat(32);
const OWNER_ID = "123456789012345678";

const ownerPeer = {
  ip: "100.64.0.2",
  nodeId: "nPhone",
  nodeName: "phone.tailnet.ts.net",
  userId: OWNER_ID,
  loginName: "khoi@github",
  tagged: false,
  tags: [],
};
const ownerSelf = { userId: OWNER_ID, tagged: false };

const preamble = (overrides: Record<string, unknown> = {}) =>
  `${JSON.stringify({ v: 1, secret: SECRET, tls: true, peer: ownerPeer, self: ownerSelf, ...overrides })}\n`;

interface Dialed {
  readonly socket: NodeNet.Socket;
  readonly verdict: number | null;
}

/** Resolves with the first byte, or null when the ingress closes without answering. */
const dial = (address: string, payload: string) =>
  Effect.promise(
    () =>
      new Promise<Dialed>((resolve) => {
        const socket = NodeNet.connect(address, () => socket.write(payload));
        const onData = (chunk: Buffer) => {
          socket.off("close", onClose);
          socket.off("data", onData);
          socket.pause();
          resolve({ socket, verdict: chunk[0] ?? null });
        };
        const onClose = () => resolve({ socket, verdict: null });
        socket.on("data", onData);
        socket.once("close", onClose);
        socket.on("error", () => undefined);
      }),
  );

const closed = (socket: NodeNet.Socket) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) return resolve();
        socket.once("close", () => resolve());
        socket.resume();
      }),
  );

const request = (socket: NodeNet.Socket) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          response += chunk;
        });
        socket.once("close", () => resolve(response));
        socket.resume();
        socket.write(
          "GET / HTTP/1.1\r\nHost: fake.tailnet.ts.net\r\nX-Forwarded-Proto: http\r\nX-Forwarded-Host: evil.example\r\nConnection: close\r\n\r\n",
        );
      }),
  );

const withIngress = <A, E>(
  authorize: (connection: TailnetIngress.TailnetConnection) => boolean,
  run: (input: {
    readonly address: string;
    readonly ingress: TailnetIngress.TailnetIngress["Service"];
    readonly handedOver: Array<{ readonly bytesWrittenAtHandover: number }>;
  }) => Effect.Effect<A, E>,
) => {
  const handedOver: Array<{ readonly bytesWrittenAtHandover: number }> = [];
  const server = TailnetIngress.installTailnetForwardedHeaders(
    NodeHttp.createServer((incoming, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          proto: incoming.headers["x-forwarded-proto"],
          forwardedHost: incoming.headers["x-forwarded-host"] ?? null,
          client: deriveAuthClientMetadata({
            request: { headers: incoming.headers, source: incoming } as never,
          }).ipAddress,
        }),
      );
    }),
  );
  return Effect.gen(function* () {
    const ingress = yield* TailnetIngress.TailnetIngress;
    const address = yield* ingress.listen({ secret: SECRET, authorize });
    return yield* run({ address, ingress, handedOver });
  }).pipe(
    Effect.provide(
      TailnetIngress.layer((socket) => {
        handedOver.push({ bytesWrittenAtHandover: socket.bytesWritten });
        server.emit("connection", socket);
      }),
    ),
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => server.close())),
  );
};

describe("TailnetIngress", () => {
  it.live(
    "hands an authorized socket to HTTP before answering, with identity from the socket",
    () =>
      withIngress(
        () => true,
        ({ address, handedOver }) =>
          Effect.gen(function* () {
            const dialed = yield* dial(address, preamble());
            expect(dialed.verdict).toBe(1);
            expect(handedOver).toEqual([{ bytesWrittenAtHandover: 0 }]);
            const response = yield* request(dialed.socket);
            const body = JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));
            expect(body).toEqual({
              proto: "https",
              forwardedHost: null,
              client: "100.64.0.2",
            });
          }),
      ),
  );

  it.live.each([
    ["a wrong secret", preamble({ secret: "cd".repeat(32) })],
    ["malformed JSON", "{not json\n"],
    ["an unknown protocol version", preamble({ v: 2 })],
    ["bytes after the preamble", `${preamble()}GET / HTTP/1.1\r\n`],
    ["an oversized preamble", "x".repeat(9 * 1024)],
  ] as const)("drops a connection with %s before any verdict", ([, payload]) =>
    withIngress(
      () => true,
      ({ address, handedOver }) =>
        Effect.gen(function* () {
          const dialed = yield* dial(address, payload);
          expect(dialed.verdict).toBeNull();
          expect(handedOver).toEqual([]);
        }),
    ),
  );

  it.live("answers a refused caller with a rejection byte and never hands it over", () =>
    withIngress(
      () => false,
      ({ address, handedOver }) =>
        Effect.gen(function* () {
          const dialed = yield* dial(address, preamble());
          expect(dialed.verdict).toBe(0);
          yield* closed(dialed.socket);
          expect(handedOver).toEqual([]);
        }),
    ),
  );

  it.live("revokes only the live sockets the new policy refuses", () =>
    withIngress(
      () => true,
      ({ address, ingress }) =>
        Effect.gen(function* () {
          const kept = yield* dial(address, preamble());
          const other = yield* dial(
            address,
            preamble({ peer: { ...ownerPeer, ip: "100.64.0.3", userId: "42" } }),
          );
          expect([kept.verdict, other.verdict]).toEqual([1, 1]);

          const destroyed = yield* ingress.revoke((connection) =>
            TailnetIngress.isTailnetOwnerAllowed({
              requireOwner: true,
              connection,
              latestSelf: ownerSelf,
            }),
          );
          expect(destroyed).toBe(1);
          yield* closed(other.socket);
          const response = yield* request(kept.socket);
          expect(response).toMatch(/^HTTP\/1\.1 200 /u);
        }),
    ),
  );
});

describe("isTailnetOwnerAllowed", () => {
  const connection = (
    peer: TailnetIngress.TailnetConnection["peer"],
    self: TailnetIngress.TailnetIngressSelf = ownerSelf,
  ): TailnetIngress.TailnetConnection => ({ tls: true, peer, self });

  it.each([
    ["an untagged peer of the same user", connection(ownerPeer), ownerSelf, true],
    ["another user's peer", connection({ ...ownerPeer, userId: "42" }), ownerSelf, false],
    ["a tagged peer", connection({ ...ownerPeer, tagged: true }), ownerSelf, false],
    [
      "a tagged node",
      connection(ownerPeer, { userId: OWNER_ID, tagged: true }),
      { userId: OWNER_ID, tagged: true },
      false,
    ],
    [
      "a node tagged since the header",
      connection(ownerPeer),
      { userId: OWNER_ID, tagged: true },
      false,
    ],
    ["a peer the sidecar could not identify", connection(null), ownerSelf, false],
    ["a stale latest self", connection(ownerPeer), { userId: "42", tagged: false }, false],
    ["no streamed self yet", connection(ownerPeer), undefined, false],
  ] as const)("with the owner limit, %s → %s", (_label, input, latestSelf, allowed) => {
    expect(
      TailnetIngress.isTailnetOwnerAllowed({ requireOwner: true, connection: input, latestSelf }),
    ).toBe(allowed);
  });

  it("lets tailnet policy decide when the owner limit is off", () => {
    expect(
      TailnetIngress.isTailnetOwnerAllowed({
        requireOwner: false,
        connection: connection(null),
        latestSelf: undefined,
      }),
    ).toBe(true);
  });
});
