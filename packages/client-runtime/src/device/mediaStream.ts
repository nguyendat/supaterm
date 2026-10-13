// @effect-diagnostics globalTimers:off - This transport also runs inside native WebViews.
/* oxlint-disable unicorn/prefer-add-event-listener -- This client owns its socket and handlers. */

import {
  DEVICE_MEDIA_HEADER_BYTES,
  DEVICE_MEDIA_MAX_CONFIG_BYTES,
  DEVICE_MEDIA_MAX_PACKET_BYTES,
  DEVICE_MEDIA_WINDOW_FRAMES,
  DeviceMediaHello,
} from "@supacode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeHello = Schema.decodeUnknownOption(DeviceMediaHello);

export interface DeviceMediaPacket {
  readonly kind: 1 | 2 | 3 | 4;
  readonly epoch: number;
  readonly configId: number;
  readonly sequence: number;
  readonly payload: Uint8Array;
}

export function parseDeviceMediaPacket(buffer: ArrayBuffer): DeviceMediaPacket {
  if (buffer.byteLength < DEVICE_MEDIA_HEADER_BYTES)
    throw new Error("Device media header was truncated.");
  const view = new DataView(buffer);
  const kind = view.getUint8(1);
  const length = view.getUint32(24);
  const epoch = view.getUint32(4);
  const configId = view.getUint32(8);
  const sequence = view.getUint32(12);
  const receiptTime = view.getFloat64(16);
  if (
    view.getUint8(0) !== 1 ||
    (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4) ||
    view.getUint16(2) !== 0 ||
    view.getUint32(28) !== 0 ||
    epoch === 0 ||
    (configId === 0 && kind !== 4) ||
    sequence === 0 ||
    !Number.isFinite(receiptTime) ||
    receiptTime < 0 ||
    length === 0 ||
    length > DEVICE_MEDIA_MAX_PACKET_BYTES ||
    (kind === 1 && length > DEVICE_MEDIA_MAX_CONFIG_BYTES) ||
    buffer.byteLength !== DEVICE_MEDIA_HEADER_BYTES + length
  )
    throw new Error("Invalid device media packet.");
  return {
    kind,
    epoch,
    configId,
    sequence,
    payload: new Uint8Array(buffer, DEVICE_MEDIA_HEADER_BYTES),
  };
}

export function createDeviceMediaTransport(
  url: string,
  events: {
    readonly onPacket: (packet: DeviceMediaPacket) => Promise<void>;
    readonly onClose: (code: number, detail: string) => void;
    readonly onError: (detail: string) => void;
  },
) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let stopped = false;
  let ready = false;
  let draining = false;
  let revision = 0;
  let sequence = 0;
  let acknowledged = 0;
  let retainedBytes = 0;
  let retainedFrames = 0;
  const pending: DeviceMediaPacket[] = [];
  let timer = setTimeout(() => fail("Device media handshake timed out."), 5_000);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    revision++;
    clearTimeout(timer);
    pending.length = 0;
    retainedBytes = 0;
    retainedFrames = 0;
    socket.close();
  };
  const fail = (detail: string) => {
    if (stopped) return;
    stop();
    events.onError(detail);
  };
  const watchVideo = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      stop();
      events.onClose(1000, "Device stream stopped receiving video. Reconnecting…");
    }, 15_000);
  };
  const acknowledge = (through: number) => {
    if (stopped || through <= acknowledged || socket.readyState !== WebSocket.OPEN) return;
    acknowledged = through;
    socket.send(JSON.stringify({ type: "ack", accountedThrough: through }));
  };
  const recover = () => {
    if (stopped || !ready || socket.readyState !== WebSocket.OPEN) return;
    revision++;
    pending.length = 0;
    retainedBytes = 0;
    retainedFrames = 0;
    socket.send(JSON.stringify({ type: "recover" }));
    acknowledge(sequence);
    watchVideo();
  };
  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    try {
      while (pending.length > 0) {
        if (stopped) return;
        const packet = pending.shift()!;
        const current = revision;
        await events.onPacket(packet);
        if (stopped) return;
        if (current !== revision) continue;
        retainedBytes -= packet.payload.byteLength;
        retainedFrames--;
        acknowledge(packet.sequence);
      }
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : "Device media could not be received.");
    } finally {
      draining = false;
    }
  };
  socket.onmessage = (event) => {
    if (stopped) return;
    try {
      if (typeof event.data === "string") {
        if (ready || Option.isNone(decodeHello(JSON.parse(event.data))))
          throw new Error("Unsupported device media handshake.");
        ready = true;
        watchVideo();
        return;
      }
      if (!ready || !(event.data instanceof ArrayBuffer))
        throw new Error("Device media arrived before its handshake.");
      const packet = parseDeviceMediaPacket(event.data);
      if (packet.sequence <= sequence) throw new Error("Device media sequence did not advance.");
      sequence = packet.sequence;
      if (
        retainedFrames >= DEVICE_MEDIA_WINDOW_FRAMES ||
        retainedBytes + packet.payload.byteLength > DEVICE_MEDIA_MAX_PACKET_BYTES
      )
        throw new Error("Device media exceeded its receive window.");
      retainedBytes += packet.payload.byteLength;
      retainedFrames++;
      pending.push(packet);
      watchVideo();
      void drain();
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : "Invalid device media response.");
    }
  };
  socket.onclose = (event) => {
    if (stopped) return;
    stopped = true;
    revision++;
    clearTimeout(timer);
    pending.length = 0;
    retainedBytes = 0;
    retainedFrames = 0;
    events.onClose(event.code, event.reason || `closed ${event.code}`);
  };
  socket.onerror = () => socket.close();
  return { stop, recover };
}
