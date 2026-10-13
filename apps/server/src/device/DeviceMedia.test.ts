// @effect-diagnostics nodeBuiltinImport:off -- The fixture exercises real HTTP and WebSocket transport lifecycle.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  DEVICE_MEDIA_HEADER_BYTES,
  DEVICE_MEDIA_MAX_PACKET_BYTES,
  DEVICE_MEDIA_WINDOW_BYTES,
  DeviceMediaHello,
  LOCAL_DEVICE_HOST_ID,
  type AuthEnvironmentScope,
  type DeviceServiceState,
} from "@supacode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceMediaRoute from "./DeviceMediaRoute.ts";

const decodeHello = Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceMediaHello));

const packet = (tag: number, payload = Uint8Array.of(1, 2, 3, 4)) => {
  const buffer = Buffer.alloc(payload.length + 5);
  buffer.writeUInt32BE(payload.length + 1);
  buffer[4] = tag;
  buffer.set(payload, 5);
  return buffer;
};

const fixture = Effect.fnUntraced(function* (
  input: { enabled?: boolean; scopes?: ReadonlyArray<AuthEnvironmentScope> } = {},
) {
  const requests = yield* Queue.unbounded<{
    response: NodeHttp.ServerResponse;
    url: string;
    headers: NodeHttp.IncomingHttpHeaders;
  }>();
  const closed = yield* Queue.unbounded<void>();
  let subscriptions = 0;
  const hub = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeHttp.createServer((request, response) => {
        subscriptions++;
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.flushHeaders();
        response.on("close", () => Queue.offerUnsafe(closed, undefined));
        Queue.offerUnsafe(requests, { response, url: request.url!, headers: request.headers });
      }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  yield* Effect.promise(() => new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve)));
  const hubAddress = hub.address();
  if (!hubAddress || typeof hubAddress === "string") throw new Error("Missing hub port");
  const state = {
    supportsDeviceMediaV1: input.enabled ?? true,
    devices: [{ hostId: "local", id: "test-ios", platform: "ios", booted: true }],
  } as unknown as DeviceServiceState;
  const services = yield* Layer.build(
    HttpRouter.serve(DeviceMediaRoute.layer.pipe(Layer.provide(FetchHttpClient.layer)), {
      disableListenLog: true,
    }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes: input.scopes ?? [AuthOrchestrationReadScope],
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provide(
        Layer.succeed(DeviceService.DeviceService, {
          state: Effect.succeed(state),
          currentReadiness: () =>
            Effect.succeed({
              hostId: LOCAL_DEVICE_HOST_ID,
              hub: { origin: `http://127.0.0.1:${hubAddress.port}` },
            }),
        } as DeviceService.DeviceService["Service"]),
      ),
    ),
  );
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  const connect = Effect.fnUntraced(function* (
    query = "device=test-ios&hostId=local&wsTicket=secret",
  ) {
    const messages = yield* Queue.unbounded<string | ArrayBuffer>();
    const disconnected = Promise.withResolvers<void>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(
          `${origin.replace(/^http/, "ws")}/api/device-media/v1?${query}`,
        );
        socket.binaryType = "arraybuffer";
        socket.addEventListener("message", (event) => Queue.offerUnsafe(messages, event.data));
        socket.addEventListener("close", () => disconnected.resolve());
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    const hello = yield* Queue.take(messages);
    expect(typeof hello).toBe("string");
    expect(yield* decodeHello(hello)).toMatchObject({
      type: "hello",
      version: 1,
      timestampOrigin: "server-receipt-monotonic",
    });
    const frame = Queue.take(messages).pipe(
      Effect.map((data) => {
        if (typeof data === "string") throw new Error("Expected media packet");
        const header = new DataView(data);
        expect(header.getUint8(0)).toBe(1);
        expect(header.getUint16(2, false)).toBe(0);
        expect(header.getUint32(28, false)).toBe(0);
        expect(header.getUint32(24, false)).toBe(data.byteLength - DEVICE_MEDIA_HEADER_BYTES);
        return {
          kind: header.getUint8(1),
          epoch: header.getUint32(4, false),
          configId: header.getUint32(8, false),
          sequence: header.getUint32(12, false),
          payload: new Uint8Array(data, DEVICE_MEDIA_HEADER_BYTES),
        };
      }),
    );
    return {
      socket,
      frame,
      ack: (accountedThrough: number) =>
        socket.send(JSON.stringify({ type: "ack", accountedThrough })),
      disconnected: Effect.promise(() => disconnected.promise),
    };
  });
  return {
    origin,
    connect,
    request: Queue.take(requests),
    closed: Queue.take(closed),
    subscriptions: () => subscriptions,
  };
});

it.live("negotiates read-only media and forwards only the selected device and panel", () =>
  Effect.gen(function* () {
    const server = yield* fixture();
    const viewer = yield* server.connect(
      "device=test-ios&hostId=local&panel=3&wsTicket=secret&authorization=private",
    );
    const source = yield* server.request;
    expect(source.url).toBe("/vendor/serve-sim/helper/test-ios/panel/3/stream.avcc");
    expect(source.headers.cookie).toBeUndefined();
    expect(source.headers.authorization).toBeUndefined();
    source.response.write(Buffer.concat([packet(1), packet(2), packet(3)]));
    const frames = yield* Effect.all([viewer.frame, viewer.frame, viewer.frame]);
    expect(
      frames.map(({ kind, sequence, epoch, configId }) => ({ kind, sequence, epoch, configId })),
    ).toEqual([
      { kind: 1, sequence: 1, epoch: 1, configId: 1 },
      { kind: 2, sequence: 2, epoch: 1, configId: 1 },
      { kind: 3, sequence: 3, epoch: 1, configId: 1 },
    ]);
    viewer.socket.close();
    yield* server.closed;
  }).pipe(Effect.scoped),
);

it.live(
  "isolates stalled viewers and resumes after cumulative credit with a fresh config and key",
  () =>
    Effect.gen(function* () {
      const server = yield* fixture();
      const stalled = yield* server.connect();
      const stalledSource = yield* server.request;
      const healthy = yield* server.connect();
      const healthySource = yield* server.request;
      stalledSource.response.write(
        Buffer.concat([packet(1), packet(2), packet(3), packet(3), packet(3)]),
      );
      const old = yield* Effect.all([stalled.frame, stalled.frame, stalled.frame, stalled.frame]);
      yield* server.closed;
      expect(old.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4]);
      expect(server.subscriptions()).toBe(2);
      stalled.ack(2);
      stalled.ack(1);
      stalled.ack(2);
      healthySource.response.write(Buffer.concat([packet(1), packet(2)]));
      yield* healthy.frame;
      expect((yield* healthy.frame).kind).toBe(2);
      expect(server.subscriptions()).toBe(2);
      stalled.ack(4);
      const resumedSource = yield* server.request;
      resumedSource.response.write(Buffer.concat([packet(3), packet(1), packet(3), packet(2)]));
      const config = yield* stalled.frame;
      const key = yield* stalled.frame;
      expect(config).toMatchObject({ kind: 1, sequence: 5, epoch: 2, configId: 2 });
      expect(key).toMatchObject({ kind: 2, sequence: 6, epoch: 2, configId: 2 });
    }).pipe(Effect.scoped),
);

it.live("admits one oversized key only after normal credit drains and charges its full size", () =>
  Effect.gen(function* () {
    const server = yield* fixture();
    const viewer = yield* server.connect();
    const source = yield* server.request;
    const payload = new Uint8Array(DEVICE_MEDIA_WINDOW_BYTES + 1).fill(7);
    source.response.write(Buffer.concat([packet(1), packet(2, payload), packet(3)]));
    expect((yield* viewer.frame).sequence).toBe(1);
    viewer.ack(1);
    const key = yield* viewer.frame;
    expect(key).toMatchObject({ kind: 2, sequence: 2 });
    expect(key.payload).toEqual(payload);
    yield* server.closed;
    expect(server.subscriptions()).toBe(1);
    viewer.ack(2);
    const recovered = yield* server.request;
    recovered.response.write(Buffer.concat([packet(1), packet(2)]));
    expect((yield* viewer.frame).sequence).toBe(3);
    expect((yield* viewer.frame).sequence).toBe(4);
  }).pipe(Effect.scoped),
);

it.live("rejects impossible credits and closes its source", () =>
  Effect.gen(function* () {
    const server = yield* fixture();
    const viewer = yield* server.connect();
    yield* server.request;
    viewer.ack(100);
    yield* viewer.disconnected;
    yield* server.closed;
    expect(server.subscriptions()).toBe(1);
  }).pipe(Effect.scoped),
);

it.live(
  "coalesces recovery requests and preserves sequence numbers across subscription epochs",
  () =>
    Effect.gen(function* () {
      const server = yield* fixture();
      const viewer = yield* server.connect();
      const source = yield* server.request;
      source.response.write(Buffer.concat([packet(1), packet(2)]));
      yield* viewer.frame;
      yield* viewer.frame;
      for (let i = 0; i < 16; i++) viewer.socket.send('{"type":"recover"}');
      viewer.ack(2);
      yield* server.closed;
      const recovered = yield* server.request;
      recovered.response.write(Buffer.concat([packet(1), packet(2)]));
      expect(yield* viewer.frame).toMatchObject({ kind: 1, sequence: 3, epoch: 2, configId: 2 });
      expect(yield* viewer.frame).toMatchObject({ kind: 2, sequence: 4, epoch: 2, configId: 2 });
      expect(server.subscriptions()).toBe(2);
    }).pipe(Effect.scoped),
);

it.live("bounds outstanding bytes before the frame window is full", () =>
  Effect.gen(function* () {
    const server = yield* fixture();
    const viewer = yield* server.connect();
    const source = yield* server.request;
    const payload = new Uint8Array(200 * 1024);
    source.response.write(
      Buffer.concat([packet(1), packet(2, payload), packet(3, payload), packet(3, payload)]),
    );
    const sent = yield* Effect.all([viewer.frame, viewer.frame, viewer.frame]);
    yield* server.closed;
    expect(sent.map((frame) => frame.sequence)).toEqual([1, 2, 3]);
    expect(server.subscriptions()).toBe(1);
    viewer.ack(3);
    const recovered = yield* server.request;
    recovered.response.write(packet(1));
    expect(yield* viewer.frame).toMatchObject({ sequence: 4, epoch: 2 });
  }).pipe(Effect.scoped),
);

it.live("closes truncated source envelopes without forwarding partial video", () =>
  Effect.gen(function* () {
    const server = yield* fixture();
    const viewer = yield* server.connect();
    const source = yield* server.request;
    source.response.end(packet(2).subarray(0, 7));
    yield* viewer.disconnected;
    yield* server.closed;
    expect(server.subscriptions()).toBe(1);
  }).pipe(Effect.scoped),
);

it.live("rejects input controls on the media socket", () =>
  Effect.gen(function* () {
    const server = yield* fixture();
    const viewer = yield* server.connect();
    yield* server.request;
    viewer.socket.send(Uint8Array.of(3, 1));
    yield* viewer.disconnected;
    yield* server.closed;
  }).pipe(Effect.scoped),
);

it.live("rejects oversized upstream envelopes before allocating their payload", () =>
  Effect.gen(function* () {
    const server = yield* fixture();
    const viewer = yield* server.connect();
    const source = yield* server.request;
    const header = Buffer.alloc(5);
    header.writeUInt32BE(DEVICE_MEDIA_MAX_PACKET_BYTES + 2);
    header[4] = 2;
    source.response.write(header);
    yield* viewer.disconnected;
    yield* server.closed;
  }).pipe(Effect.scoped),
);

it.live("rejects unsupported or unauthorized media before opening upstream", () =>
  Effect.gen(function* () {
    for (const [input, query, status] of [
      [{ enabled: false }, "device=test-ios", 503],
      [{ scopes: [] }, "device=test-ios", 403],
      [{}, "device=unknown", 404],
      [{}, "device=test-ios&hostId=unknown", 404],
      [{}, "device=test-ios&panel=2", 400],
    ] as const) {
      const server = yield* fixture(input);
      const statusCode = yield* Effect.promise(
        () =>
          new Promise<number | undefined>((resolve, reject) => {
            const req = NodeHttp.request(
              `${server.origin}/api/device-media/v1?${query}`,
              { headers: { upgrade: "websocket" } },
              (response) => {
                response.resume();
                resolve(response.statusCode);
              },
            );
            req.on("error", reject);
            req.end();
          }),
      );
      expect(statusCode).toBe(status);
      expect(server.subscriptions()).toBe(0);
    }
  }).pipe(Effect.scoped),
);
