import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebSocket drainage is exposed by the Node transport.
import type * as NodeStream from "node:stream";

const waitForDrain = (transport: NodeStream.Duplex) =>
  Effect.callback<void, Socket.SocketError>((resume) => {
    const cleanup = () => {
      transport.off("drain", drained);
      transport.off("close", closed);
    };
    const closed = () => {
      cleanup();
      resume(
        Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketWriteError({ cause: new Error("Device socket closed") }),
          }),
        ),
      );
    };
    const drained = () => {
      cleanup();
      resume(Effect.void);
    };
    if (transport.destroyed) return closed();
    if (!transport.writableNeedDrain) return resume(Effect.void);
    transport.once("drain", drained);
    transport.once("close", closed);
    return Effect.sync(cleanup);
  });

const pump = Effect.fnUntraced(function* (
  reader: Socket.Reader,
  write: (chunk: Uint8Array | string) => Effect.Effect<void, Socket.SocketError>,
) {
  while (true) {
    for (const frame of yield* reader.pull) yield* write(frame);
  }
});

export const bridgeDeviceSocket = Effect.fn("DeviceHubSocket.bridge")(function* (
  client: Socket.Socket,
  transport: NodeStream.Duplex,
  upstreamUrl: string,
) {
  const clientReader = yield* client.reader;
  const upstreamSocket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new NodeWS.WebSocket(upstreamUrl, {
        perMessageDeflate: false,
        maxPayload: 8 * 1024 * 1024,
      });
      socket.on("error", () => {});
      return socket;
    }),
    (socket) => Effect.sync(() => socket.terminate()),
  );
  const upstream = yield* Socket.fromWebSocket(Effect.succeed(upstreamSocket), {
    openTimeout: "10 seconds",
    highWaterMark: 64 * 1024,
  });
  const upstreamReader = yield* upstream.reader;
  const writer = yield* client.writer;
  const sendUpstream = (chunk: Uint8Array | string) =>
    Effect.callback<void, Socket.SocketError>((resume) => {
      const complete = (cause?: Error) =>
        resume(
          cause
            ? Effect.fail(
                new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
              )
            : Effect.void,
        );
      try {
        upstreamSocket.send(chunk, complete);
      } catch (cause) {
        resume(
          Effect.fail(new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) })),
        );
      }
    });
  return yield* Effect.raceFirst(
    pump(upstreamReader, (frame) =>
      writer.write(frame).pipe(Effect.andThen(waitForDrain(transport))),
    ),
    pump(clientReader, sendUpstream),
  );
});
