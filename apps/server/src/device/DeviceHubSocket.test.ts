import { NodeWS } from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The controlled writable verifies native socket drainage.
import * as NodeStream from "node:stream";

import { bridgeDeviceSocket } from "./DeviceHubSocket.ts";

it.effect(
  "stalls video at socket drainage while forwarding input and releasing stalled readers",
  () =>
    Effect.gen(function* () {
      const hub = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const client of server.clients) client.terminate();
                server.close(() => resolve());
              }),
          ),
      );
      if (!hub.address())
        yield* Effect.promise(() => new Promise<void>((resolve) => hub.once("listening", resolve)));
      const address = hub.address();
      if (!address || typeof address === "string") throw new Error("Missing hub port");
      const inputReceived = Promise.withResolvers<string>();
      const upstreamClosed = Promise.withResolvers<void>();
      hub.on("connection", (socket) => {
        expect(socket.extensions).toBe("");
        socket.once("close", () => upstreamClosed.resolve());
        socket.on("message", (data) => inputReceived.resolve(data.toString()));
        for (let index = 0; index < 16; index++) socket.send(new Uint8Array(64 * 1024).fill(index));
      });
      const firstWrite = Promise.withResolvers<void>();
      const secondWrite = Promise.withResolvers<void>();
      const writes: Buffer[] = [];
      let releaseWrite: (() => void) | undefined;
      const transport = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new NodeStream.Duplex({
              writableHighWaterMark: 1,
              read() {},
              write(chunk: Buffer, _encoding, callback) {
                writes.push(chunk);
                releaseWrite = callback;
                if (writes.length === 1) firstWrite.resolve();
                if (writes.length === 2) secondWrite.resolve();
              },
            }),
        ),
        (stream) => Effect.sync(() => stream.destroy()),
      );
      const input = yield* Queue.make<string>();
      const write: Socket.Writer["write"] = (frame) =>
        Effect.sync(() => {
          if (!Socket.isCloseEvent(frame)) transport.write(frame);
        });
      const client = Socket.make({
        reader: Effect.succeed({
          pull: Queue.take(input).pipe(Effect.map((frame) => [frame] as const)),
          upgrade: Socket.SocketUpgradeError.unsupported,
        }),
        writer: Effect.succeed({
          write,
          writeAll: (frames) => Effect.forEach(frames, write, { discard: true }),
        }),
      });
      const bridge = yield* bridgeDeviceSocket(
        client,
        transport,
        `ws://127.0.0.1:${address.port}`,
      ).pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.promise(() => firstWrite.promise);
      yield* Queue.offer(input, "input during stalled video");
      expect(yield* Effect.promise(() => inputReceived.promise)).toBe("input during stalled video");
      expect(writes).toHaveLength(1);
      expect(transport.writableLength).toBe(64 * 1024);
      releaseWrite!();
      yield* Effect.promise(() => secondWrite.promise);
      expect(writes[1]![0]).toBe(1);
      expect(transport.listenerCount("drain")).toBe(1);
      yield* Fiber.interrupt(bridge);
      yield* Effect.promise(() => upstreamClosed.promise);
      expect(transport.listenerCount("drain")).toBe(0);
      expect(transport.listenerCount("close")).toBe(0);
    }),
);
