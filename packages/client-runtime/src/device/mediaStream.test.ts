import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEVICE_MEDIA_HEADER_BYTES,
  DEVICE_MEDIA_MAX_CONFIG_BYTES,
  DEVICE_MEDIA_MAX_PACKET_BYTES,
  DEVICE_MEDIA_WINDOW_BYTES,
  DEVICE_MEDIA_WINDOW_FRAMES,
} from "@supacode/contracts";

import { createDeviceMediaTransport, parseDeviceMediaPacket } from "./mediaStream.ts";

const packet = (sequence = 1, length = 1, kind = 2) => {
  const buffer = new ArrayBuffer(DEVICE_MEDIA_HEADER_BYTES + length);
  const view = new DataView(buffer);
  view.setUint8(0, 1);
  view.setUint8(1, kind);
  view.setUint32(4, 1);
  view.setUint32(8, 1);
  view.setUint32(12, sequence);
  view.setFloat64(16, 1234);
  view.setUint32(24, length);
  return buffer;
};

const hello = JSON.stringify({
  type: "hello",
  version: 1,
  timestampOrigin: "server-receipt-monotonic",
  windowBytes: DEVICE_MEDIA_WINDOW_BYTES,
  windowFrames: DEVICE_MEDIA_WINDOW_FRAMES,
  maxPacketBytes: DEVICE_MEDIA_MAX_PACKET_BYTES,
  maxConfigBytes: DEVICE_MEDIA_MAX_CONFIG_BYTES,
});

describe("device media framing", () => {
  it("borrows the exact bounded payload from the received packet", () => {
    const buffer = packet();
    const parsed = parseDeviceMediaPacket(buffer);
    expect(parsed).toMatchObject({ kind: 2, epoch: 1, configId: 1, sequence: 1 });
    expect(parsed.payload.buffer).toBe(buffer);
    expect(parsed.payload.byteOffset).toBe(DEVICE_MEDIA_HEADER_BYTES);
    expect(parsed.payload.byteLength).toBe(1);
  });

  it.each([0, 31, 32])("rejects truncated or empty packets of %s bytes", (length) => {
    expect(() => parseDeviceMediaPacket(new ArrayBuffer(length))).toThrow();
  });

  it.each([
    [0, 2],
    [1, 9],
    [2, 1],
    [28, 1],
  ])("rejects an unsupported header byte at %s", (offset, value) => {
    const buffer = packet();
    new Uint8Array(buffer)[offset] = value;
    expect(() => parseDeviceMediaPacket(buffer)).toThrow("Invalid device media");
  });

  it("rejects oversized descriptions, payloads and forged length fields", () => {
    expect(() => parseDeviceMediaPacket(packet(1, DEVICE_MEDIA_MAX_CONFIG_BYTES + 1, 1))).toThrow();
    expect(() => parseDeviceMediaPacket(packet(1, DEVICE_MEDIA_MAX_PACKET_BYTES + 1))).toThrow();
    const buffer = packet();
    new DataView(buffer).setUint32(24, DEVICE_MEDIA_MAX_PACKET_BYTES);
    expect(() => parseDeviceMediaPacket(buffer)).toThrow();
  });
});

describe("device media receive ownership", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const setup = () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    class Socket {
      static OPEN = 1;
      readyState = 1;
      onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const events = {
      onPacket: vi.fn(() => accepted),
      onClose: vi.fn(),
      onError: vi.fn(),
    };
    const transport = createDeviceMediaTransport("wss://test/api/device-media/v1", events);
    return { socket: sockets[0]!, events, transport, accept };
  };

  it("rejects a sender that exceeds its envelope window while acceptance is pending", () => {
    const { socket, events } = setup();
    socket.onmessage?.({ data: hello });
    for (let sequence = 1; sequence <= DEVICE_MEDIA_WINDOW_FRAMES + 1; sequence++)
      socket.onmessage?.({ data: packet(sequence) });
    expect(events.onPacket).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(
      "Device media exceeded its receive window.",
    );
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes an oversized compressed receive pool before accepting another keyframe", () => {
    const { socket, events } = setup();
    socket.onmessage?.({ data: hello });
    socket.onmessage?.({ data: packet(1, DEVICE_MEDIA_MAX_PACKET_BYTES) });
    socket.onmessage?.({ data: packet(2) });
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(
      "Device media exceeded its receive window.",
    );
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("discards retained envelopes before acknowledging recovery and ignores late acceptance after stop", async () => {
    const { socket, events, transport, accept } = setup();
    socket.onmessage?.({ data: hello });
    socket.onmessage?.({ data: packet(1) });
    socket.onmessage?.({ data: packet(2) });
    transport.recover();
    expect(socket.send.mock.calls.map(([message]) => JSON.parse(message as string))).toEqual([
      { type: "recover" },
      { type: "ack", accountedThrough: 2 },
    ]);
    transport.stop();
    accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onPacket).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never accepts binary bytes before a compatible hello", () => {
    const { socket, events } = setup();
    socket.onmessage?.({ data: packet() });
    expect(events.onPacket).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(
      "Device media arrived before its handshake.",
    );
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("refreshes the stall deadline only for valid media and clears it when hidden", async () => {
    const { socket, events, transport, accept } = setup();
    socket.onmessage?.({ data: hello });
    accept();
    await vi.advanceTimersByTimeAsync(14_000);
    socket.onmessage?.({ data: packet() });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(socket.close).not.toHaveBeenCalled();
    expect(events.onClose).not.toHaveBeenCalled();
    transport.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.onClose).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
