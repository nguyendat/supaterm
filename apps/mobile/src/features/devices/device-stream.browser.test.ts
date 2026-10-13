import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  DEVICE_MEDIA_HEADER_BYTES,
  DEVICE_MEDIA_MAX_CONFIG_BYTES,
  DEVICE_MEDIA_MAX_PACKET_BYTES,
  DEVICE_MEDIA_WINDOW_BYTES,
  DEVICE_MEDIA_WINDOW_FRAMES,
} from "@supacode/contracts";
import { start, stop } from "./device-stream.browser";

class Element extends EventTarget {
  readonly style = {};
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  setAttribute() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  append() {}
}

async function setup(mediaV1 = false) {
  vi.useFakeTimers();
  const elements: Element[] = [];
  vi.stubGlobal("document", {
    documentElement: { style: {} },
    body: { style: {}, replaceChildren() {} },
    createElement: (tag: string) => {
      const element = new Element(tag);
      elements.push(element);
      return element;
    },
  });
  const postMessage = vi.fn();
  vi.stubGlobal("window", { ReactNativeWebView: { postMessage }, addEventListener() {} });
  const fetch = vi.fn(() => Promise.resolve(new Response("prime")));
  vi.stubGlobal("fetch", fetch);
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
    close = vi.fn();
    send = vi.fn();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const configuration = {
    platform: "ios" as const,
    deviceId: "fixture-device",
    access: {
      httpBase: "https://device.test",
      wsBase: "wss://device.test",
      ...(mediaV1 ? { mediaV1WsBase: "wss://device.test/api/device-media/v1" } : {}),
      credentials: false,
      query: {},
    },
    colors: {
      background: "white",
      foreground: "black",
      muted: "gray",
      buttonBackground: "gray",
      buttonForeground: "black",
      buttonBorder: "gray",
    },
  };
  start(configuration);
  await vi.advanceTimersByTimeAsync(0);
  return {
    configuration,
    elements,
    sockets,
    fetch,
    messages: () =>
      postMessage.mock.calls.map(
        ([message]) => JSON.parse(message as string) as { type: string; status?: string },
      ),
  };
}

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps the authenticated image fallback when the WebView cannot probe a decoder profile", async () => {
  vi.stubGlobal("VideoDecoder", vi.fn());
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  const { sockets, elements } = await setup(true);
  expect(sockets.some((socket) => socket.url.includes("device-media"))).toBe(false);
  expect(elements.find((element) => element.tag === "img")!.src).toContain("stream.mjpeg");
  sockets[0]!.onmessage?.({ data: Uint8Array.of(0x83).buffer });
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("uses negotiated H264 in the WebView and bridges status without sending decoded frames to native", async () => {
  let output!: VideoFrameOutputCallback;
  const decode = vi.fn();
  class Decoder {
    static isConfigSupported = vi.fn(async () => ({ supported: true }));
    state = "unconfigured";
    decodeQueueSize = 0;
    readonly decode = decode;
    constructor(options: VideoDecoderInit) {
      output = options.output;
    }
    configure() {
      this.state = "configured";
    }
    close() {
      this.state = "closed";
    }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  const { sockets, elements, messages, fetch } = await setup(true);
  const mediaSocket = sockets.find((socket) => socket.url.includes("device-media"))!;
  expect(mediaSocket.url).toBe("wss://device.test/api/device-media/v1?device=fixture-device");
  const canvas = elements.find((element) => element.tag === "canvas")!;
  const drawImage = vi.fn();
  Object.assign(canvas, { getContext: () => ({ drawImage }) });
  mediaSocket.onmessage?.({
    data: JSON.stringify({
      type: "hello",
      version: 1,
      timestampOrigin: "server-receipt-monotonic",
      windowBytes: DEVICE_MEDIA_WINDOW_BYTES,
      windowFrames: DEVICE_MEDIA_WINDOW_FRAMES,
      maxPacketBytes: DEVICE_MEDIA_MAX_PACKET_BYTES,
      maxConfigBytes: DEVICE_MEDIA_MAX_CONFIG_BYTES,
    }),
  });
  const packet = (sequence: number, kind: number) => {
    const payload = Uint8Array.of(1, 0x64, 0, 0x1f);
    const bytes = new ArrayBuffer(DEVICE_MEDIA_HEADER_BYTES + payload.byteLength);
    const view = new DataView(bytes);
    view.setUint8(0, 1);
    view.setUint8(1, kind);
    view.setUint32(4, 1);
    view.setUint32(8, 1);
    view.setUint32(12, sequence);
    view.setFloat64(16, 1234);
    view.setUint32(24, payload.byteLength);
    new Uint8Array(bytes, DEVICE_MEDIA_HEADER_BYTES).set(payload);
    return bytes;
  };
  mediaSocket.onmessage?.({ data: packet(1, 1) });
  mediaSocket.onmessage?.({ data: packet(2, 2) });
  await vi.advanceTimersByTimeAsync(0);
  expect(Decoder.isConfigSupported).toHaveBeenCalledOnce();
  expect(decode).toHaveBeenCalledOnce();
  const close = vi.fn();
  output({ timestamp: 0, displayWidth: 400, displayHeight: 800, close } as unknown as VideoFrame);
  expect(drawImage).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(messages()).toContainEqual({ type: "status", status: "streaming" });
  expect(messages().every((message) => ["status", "input"].includes(message.type))).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(elements.find((element) => element.tag === "img")!.src).toBe("");
  stop();
  expect(mediaSocket.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("bridges shared first-frame readiness, image failure, and a successful fresh attempt to native", async () => {
  const { elements, messages, sockets, configuration } = await setup();
  sockets[0]!.onopen?.();
  expect(messages()).not.toContainEqual({ type: "status", status: "streaming" });
  expect(messages()).not.toContainEqual({ type: "input", connected: true });
  sockets[0]!.onmessage?.({ data: new Uint8Array([0x83]).buffer });
  expect(messages()).toContainEqual({ type: "input", connected: true });
  const image = elements.find((element) => element.tag === "img")!;
  image.naturalWidth = 400;
  image.naturalHeight = 800;
  await vi.advanceTimersByTimeAsync(250);
  expect(messages()).toContainEqual({ type: "status", status: "streaming" });
  image.dispatchEvent(new Event("error"));
  expect(messages()).toContainEqual({
    type: "status",
    status: "error",
    detail: "Could not receive the device stream. Reconnect to try again.",
  });
  expect(messages()).toContainEqual({ type: "input", connected: false });
  expect(messages()).not.toContainEqual({ type: "unauthorized" });
  expect(image.src).toBe("");
  expect(sockets[0]!.close).toHaveBeenCalledOnce();
  start(configuration);
  await vi.advanceTimersByTimeAsync(0);
  const replacement = elements.findLast((element) => element.tag === "img")!;
  replacement.naturalWidth = 400;
  replacement.naturalHeight = 800;
  replacement.dispatchEvent(new Event("load"));
  expect(messages().at(-1)).toEqual({ type: "status", status: "streaming" });
  image.dispatchEvent(new Event("error"));
  expect(sockets[1]!.close).not.toHaveBeenCalled();
  stop();
  expect(replacement.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});
