import {
  DEVICE_MEDIA_HEADER_BYTES,
  DEVICE_MEDIA_MAX_CONFIG_BYTES,
  DEVICE_MEDIA_MAX_PACKET_BYTES,
  DEVICE_MEDIA_WINDOW_BYTES,
  DEVICE_MEDIA_WINDOW_FRAMES,
  DeviceMediaClientMessage,
  DeviceMediaHello,
  type DeviceMediaTarget,
} from "@supacode/contracts";
import { AvccEnvelopeParser } from "@supacode/shared/device/avcc";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as DeviceService from "./DeviceService.ts";

export class DeviceMediaError extends Schema.TaggedError<DeviceMediaError>()("DeviceMediaError", {
  reason: Schema.Literals(["unavailable", "target", "upstream", "packet", "control"]),
}) {}

class SourceRestart extends Schema.TaggedError<SourceRestart>()("DeviceMediaSourceRestart", {}) {}

export class DeviceMedia extends Context.Service<
  DeviceMedia,
  {
    readonly open: (target: DeviceMediaTarget) => Effect.Effect<
      {
        readonly run: (
          socket: Socket.Socket,
        ) => Effect.Effect<void, DeviceMediaError | Socket.SocketError, Scope.Scope>;
      },
      DeviceMediaError
    >;
  }
>()("supacode/device/DeviceMedia") {}

const hello: DeviceMediaHello = {
  type: "hello",
  version: 1,
  timestampOrigin: "server-receipt-monotonic",
  windowBytes: DEVICE_MEDIA_WINDOW_BYTES,
  windowFrames: DEVICE_MEDIA_WINDOW_FRAMES,
  maxPacketBytes: DEVICE_MEDIA_MAX_PACKET_BYTES,
  maxConfigBytes: DEVICE_MEDIA_MAX_CONFIG_BYTES,
};
const decodeControl = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceMediaClientMessage));
const encodedHello = Schema.encodeSync(Schema.fromJsonString(DeviceMediaHello))(hello);
const isMediaError = Schema.is(DeviceMediaError);
const isSourceRestart = Schema.is(SourceRestart);
const WEBSOCKET_HEADER_BYTES = 14;

const make = Effect.gen(function* () {
  const devices = yield* DeviceService.DeviceService;
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);

  const open = Effect.fn("DeviceMedia.open")(function* (target: DeviceMediaTarget) {
    const state = yield* devices.state;
    if (!state.supportsDeviceMediaV1) return yield* new DeviceMediaError({ reason: "unavailable" });
    if (
      !state.devices.some(
        (device) =>
          device.id === target.device &&
          device.hostId === target.hostId &&
          device.platform === "ios" &&
          device.booted,
      )
    )
      return yield* new DeviceMediaError({ reason: "target" });
    const ready = yield* devices.currentReadiness(target.hostId);
    if (!ready) return yield* new DeviceMediaError({ reason: "unavailable" });
    const path = `/vendor/serve-sim/helper/${encodeURIComponent(target.device)}${target.panel ? `/panel/${target.panel}` : ""}/stream.avcc`;
    const url = `${ready.hub.origin}${path}`;

    const run = Effect.fn("DeviceMedia.run")(function* (socket: Socket.Socket) {
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const wake = yield* Latch.make();
      const ledger: Array<{ sequence: number; bytes: number }> = [];
      let outstandingBytes = 0;
      let sequence = 0;
      let accountedThrough = 0;
      let epoch = 0;
      let configId = 0;
      let restart: Deferred.Deferred<void> | undefined;

      const drain = Effect.gen(function* () {
        while (ledger.length > 0) {
          yield* wake.close;
          if (ledger.length > 0) yield* wake.await;
        }
      });

      const controls = Effect.gen(function* () {
        while (true) {
          const batch = yield* reader.pull;
          for (const chunk of batch) {
            if (typeof chunk !== "string" || chunk.length > 1024)
              return yield* new DeviceMediaError({ reason: "control" });
            const decoded = decodeControl(chunk);
            if (Option.isNone(decoded)) return yield* new DeviceMediaError({ reason: "control" });
            const message = decoded.value;
            if (message.type === "recover") {
              if (restart) yield* Deferred.succeed(restart, undefined);
              continue;
            }
            if (message.accountedThrough > sequence)
              return yield* new DeviceMediaError({ reason: "control" });
            if (message.accountedThrough <= accountedThrough) continue;
            accountedThrough = message.accountedThrough;
            while (ledger[0] && ledger[0].sequence <= accountedThrough) {
              outstandingBytes -= ledger.shift()!.bytes;
            }
            yield* wake.open;
          }
        }
      });

      const source = Effect.gen(function* () {
        while (true) {
          yield* drain;
          if (epoch > 0) yield* Effect.sleep("500 millis");
          if (++epoch > 0xffffffff) return yield* new DeviceMediaError({ reason: "packet" });
          const reset = yield* Deferred.make<void>();
          restart = reset;
          const consume = Effect.scoped(
            Effect.gen(function* () {
              const response = yield* client
                .execute(HttpClientRequest.get(url))
                .pipe(Effect.mapError(() => new DeviceMediaError({ reason: "upstream" })));
              if (response.status !== 200)
                return yield* new DeviceMediaError({ reason: "upstream" });
              const parser = new AvccEnvelopeParser({ unknownTags: "reject" });
              let hasConfig = false;
              let needsKey = true;
              yield* Stream.runForEach(response.stream, (chunk) =>
                Effect.gen(function* () {
                  const receivedAt = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
                  const packets = parser.push(chunk);
                  while (true) {
                    const next = yield* Effect.try({
                      try: () => packets.next(),
                      catch: () => new DeviceMediaError({ reason: "packet" }),
                    });
                    if (next.done) break;
                    const { tag, payload } = next.value;
                    if (tag === 1) {
                      if (++configId > 0xffffffff)
                        return yield* new DeviceMediaError({ reason: "packet" });
                      hasConfig = true;
                      needsKey = true;
                    } else if (tag === 2) {
                      if (!hasConfig) continue;
                      needsKey = false;
                    } else if (tag === 3 && (!hasConfig || needsKey)) continue;
                    const bytes =
                      DEVICE_MEDIA_HEADER_BYTES + payload.byteLength + WEBSOCKET_HEADER_BYTES;
                    if (tag === 4 && bytes > DEVICE_MEDIA_WINDOW_BYTES) continue;
                    if (bytes > DEVICE_MEDIA_WINDOW_BYTES) {
                      if (tag !== 2) return yield* new DeviceMediaError({ reason: "packet" });
                      yield* drain;
                    } else if (
                      ledger.length >= DEVICE_MEDIA_WINDOW_FRAMES ||
                      outstandingBytes + bytes > DEVICE_MEDIA_WINDOW_BYTES
                    ) {
                      return yield* new SourceRestart({});
                    }
                    if (++sequence > 0xffffffff)
                      return yield* new DeviceMediaError({ reason: "packet" });
                    const encoded = new Uint8Array(DEVICE_MEDIA_HEADER_BYTES + payload.length);
                    const header = new DataView(encoded.buffer);
                    header.setUint8(0, 1);
                    header.setUint8(1, tag);
                    header.setUint32(4, epoch, false);
                    header.setUint32(8, configId, false);
                    header.setUint32(12, sequence, false);
                    header.setFloat64(16, receivedAt, false);
                    header.setUint32(24, payload.length, false);
                    encoded.set(payload, DEVICE_MEDIA_HEADER_BYTES);
                    ledger.push({ sequence, bytes });
                    outstandingBytes += bytes;
                    yield* writer.write(encoded);
                  }
                }),
              ).pipe(
                Effect.mapError((error) =>
                  isSourceRestart(error) || isMediaError(error) || Socket.isSocketError(error)
                    ? error
                    : new DeviceMediaError({ reason: "upstream" }),
                ),
              );
              yield* Effect.try({
                try: () => parser.end(),
                catch: () => new DeviceMediaError({ reason: "packet" }),
              });
              return yield* new DeviceMediaError({ reason: "upstream" });
            }),
          );
          yield* Effect.raceFirst(consume, Deferred.await(reset)).pipe(
            Effect.catchTags({ DeviceMediaSourceRestart: () => Effect.void }),
          );
          restart = undefined;
        }
      });

      yield* writer.write(encodedHello);
      return yield* Effect.raceFirst(source, controls);
    });
    return { run };
  });
  return DeviceMedia.of({ open });
});

export const layer = Layer.effect(DeviceMedia, make);
