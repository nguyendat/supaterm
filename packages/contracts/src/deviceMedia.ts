import * as Schema from "effect/Schema";

import { DeviceHostId, DeviceId } from "./device.ts";

export const DEVICE_MEDIA_V1_PATH = "/api/device-media/v1";
export const DEVICE_MEDIA_HEADER_BYTES = 32;
export const DEVICE_MEDIA_WINDOW_BYTES = 512 * 1024;
export const DEVICE_MEDIA_WINDOW_FRAMES = 4;
export const DEVICE_MEDIA_MAX_PACKET_BYTES = 4 * 1024 * 1024;
export const DEVICE_MEDIA_MAX_CONFIG_BYTES = 64 * 1024;
export const DEVICE_MEDIA_MAX_READ_BYTES = 8 * 1024 * 1024;
export const DEVICE_MEDIA_MAX_READ_PACKETS = 4096;

export const DeviceMediaTarget = Schema.Struct({
  device: DeviceId,
  hostId: DeviceHostId,
  panel: Schema.optional(Schema.Literals(["1", "3"])),
});
export type DeviceMediaTarget = typeof DeviceMediaTarget.Type;

export const DeviceMediaHello = Schema.Struct({
  type: Schema.Literal("hello"),
  version: Schema.Literal(1),
  timestampOrigin: Schema.Literal("server-receipt-monotonic"),
  windowBytes: Schema.Literal(DEVICE_MEDIA_WINDOW_BYTES),
  windowFrames: Schema.Literal(DEVICE_MEDIA_WINDOW_FRAMES),
  maxPacketBytes: Schema.Literal(DEVICE_MEDIA_MAX_PACKET_BYTES),
  maxConfigBytes: Schema.Literal(DEVICE_MEDIA_MAX_CONFIG_BYTES),
});
export type DeviceMediaHello = typeof DeviceMediaHello.Type;

export const DeviceMediaClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ack"),
    accountedThrough: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff })),
  }),
  Schema.Struct({ type: Schema.Literal("recover") }),
]);
