// @effect-diagnostics globalFetch:off globalTimers:off - This browser and WebView transport runs without an Effect runtime.
/* oxlint-disable unicorn/prefer-add-event-listener -- Each client owns its sockets and their handlers. */

/**
 * Framework-free client for expo-device-hub's per-device streams, reached
 * through the Supacode proxy. One class handles both platforms because the hub
 * vendors two servers with different wire formats:
 *
 * - iOS (serve-sim): video is an HTTP `stream.avcc` body of length-prefixed
 *   envelopes (`u32be length, u8 tag, payload`; tag 1 avcC description,
 *   2 keyframe, 3 delta, 4 JPEG seed) decoded with WebCodecs; input goes over
 *   `helper/ws?device=<udid>` as `[tag][json]` packets. When WebCodecs is
 *   unavailable (plain-http remote origins) the MJPEG endpoint is used as an
 *   `<img>` source instead.
 * - Android (serve-emu): one WebSocket at `ws?device=<serial>&frame-meta=1`
 *   carries H.264 access units prefixed with a 16-byte "SEMU" header
 *   (magic, version, key flag, pts) and accepts JSON gestures upstream.
 *
 * The decoder only runs while frames arrive and the viewer is attached; a
 * hidden panel calls `stop()` so an idle device costs nothing on the GPU.
 */
import {
  createDuoControl,
  type DuoCommand,
  type DuoControlState,
  type DuoPose,
} from "./duoControl.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { createCanvasFrameSink, isDeviceFrameSize, type DeviceFrameSink } from "./frame.ts";
import { type DeviceHubAccess, withDeviceHubQuery } from "./hubAccess.ts";
import { createDeviceMediaTransport } from "./mediaStream.ts";
import { DEVICE_MEDIA_MAX_PACKET_BYTES, type DevicePlatform } from "@supacode/contracts";
import { AvccEnvelopeParser } from "@supacode/shared/device/avcc";

export type DeviceStreamStatus = "connecting" | "streaming" | "error";

export interface DeviceScreenSize {
  readonly width: number;
  readonly height: number;
  readonly orientation: "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";
  readonly screenId?: number;
  readonly supportsHingeAngle?: boolean;
  readonly supportsPhysicalOrientation?: boolean;
  readonly hingeAngle?: number;
  readonly hingePose?: DuoPose | null;
  readonly tableMode?: boolean;
  readonly tableModeAvailable?: boolean;
}

const screenConfigSchema = Schema.Struct({
  width: Schema.Finite.check(Schema.isGreaterThan(0)),
  height: Schema.Finite.check(Schema.isGreaterThan(0)),
  orientation: Schema.Literals([
    "portrait",
    "portrait_upside_down",
    "landscape_left",
    "landscape_right",
  ]),
  inputUnavailable: Schema.optionalKey(Schema.Boolean),
  screenId: Schema.optionalKey(Schema.Number),
  supportsHingeAngle: Schema.optionalKey(Schema.Boolean),
  supportsPhysicalOrientation: Schema.optionalKey(Schema.Boolean),
  hingeAngle: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 180 })),
  ),
  hingePose: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["closed", "book", "open", "laptop", "tent"])),
  ),
  tableMode: Schema.optionalKey(Schema.Boolean),
  tableModeAvailable: Schema.optionalKey(Schema.Boolean),
});
const controlReplySchema = Schema.Struct({
  requestId: Schema.Int,
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
const decodeScreenConfig = Schema.decodeUnknownOption(screenConfigSchema);
const decodeControlReply = Schema.decodeUnknownOption(controlReplySchema);

export interface DuoPanelSinks {
  readonly cover: DeviceFrameSink;
  readonly inner: DeviceFrameSink;
  /** Invalidate captured input synchronously, before React can commit the new layout. */
  readonly onScreen?: (screen: DeviceScreenSize) => void;
}

export interface DeviceStreamEvents {
  readonly onDuoControl?: (state: DuoControlState) => void;
  /** A fixed panel cannot be decoded; the owner should return to the active flat feed. */
  readonly onDuoUnavailable?: (detail?: string) => void;
  readonly onStatus: (status: DeviceStreamStatus, detail?: string) => void;
  readonly onScreen: (screen: DeviceScreenSize) => void;
  /** The proxy rejected the credential; the owner should refresh access and reconnect. */
  readonly onUnauthorized: () => void;
  /**
   * H.264 cannot be decoded here (no WebCodecs, or the simulator's profile is
   * unsupported); the owner should show an `<img>` instead of the canvas
   * and attach it with `setMjpegImage` so the client can observe real frames.
   */
  readonly onMjpegFallback: (url: string) => void;
  /** Whether touches and keys can currently reach the device. */
  readonly onInputConnected: (connected: boolean, detail?: string) => void;
}

export interface DeviceStreamTarget {
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly access: DeviceHubAccess;
  /** Native iOS WebViews can use MJPEG without cross-origin fetch or secure-context support. */
  readonly preferMjpeg?: boolean;
  /** Internal fixed-panel feeds share their parent's input session. */
  readonly panelId?: 1 | 3;
  readonly videoOnly?: boolean;
}

export type DeviceHardwareButton = "home" | "back" | "recents" | "power" | "appSwitcher";

const RETRY_DELAY_MS = 1_000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const MJPEG_FRAME_CHECK_MS = 250;
const FRAME_DURATION_US = 16_667;
const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER_BYTES = 16;
const SEMU_FLAG_KEY = 1;
const MAX_DECODE_QUEUE = 4;

// serve-sim binary WS message tags (browser -> helper).
const IOS_MSG_TOUCH = 0x03;
const IOS_MSG_BUTTON = 0x04;
const IOS_MSG_KEY = 0x06;
const IOS_MSG_ORIENTATION = 0x07;
// helper -> browser.
const IOS_TAG_SCREEN_CONFIG = 0x82;
const IOS_TAG_INPUT_ADMITTED = 0x83;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isWebCodecsSupported = (): boolean =>
  typeof globalThis !== "undefined" &&
  typeof globalThis.VideoDecoder === "function" &&
  typeof globalThis.VideoDecoder.isConfigSupported === "function" &&
  typeof globalThis.EncodedVideoChunk === "function";

function taggedJson(tag: number, payload: unknown): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

/** Build the WebCodecs `avc1.PPCCLL` string from an avcC record or an SPS NAL. */
export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
}

/** Split serve-emu's SEMU-framed message into metadata and the Annex-B payload. */
export function parseSemuPacket(raw: ArrayBuffer): {
  readonly data: Uint8Array;
  readonly isKey: boolean | null;
  readonly timestamp: number | null;
} {
  const bytes = new Uint8Array(raw);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > DEVICE_MEDIA_MAX_PACKET_BYTES + SEMU_HEADER_BYTES
  )
    throw new Error("Invalid device video packet length.");
  if (bytes.byteLength >= 4) {
    const view = new DataView(raw);
    if (view.getUint32(0, false) === SEMU_MAGIC) {
      if (bytes.byteLength <= SEMU_HEADER_BYTES || view.getUint8(4) !== 1)
        throw new Error("Invalid device video packet header.");
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(SEMU_HEADER_BYTES),
        isKey: (view.getUint8(5) & SEMU_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  if (bytes.byteLength > DEVICE_MEDIA_MAX_PACKET_BYTES)
    throw new Error("Invalid device video packet length.");
  return { data: bytes, isKey: null, timestamp: null };
}

const isVideoSessionMessage = (text: string) => {
  try {
    const message = JSON.parse(text) as { type?: unknown };
    return message.type === "video-session";
  } catch {
    return false;
  }
};

/** Walk an Annex-B access unit for its keyframe flag and SPS bytes. */
export function scanAccessUnit(buf: Uint8Array): { isKey: boolean; sps: Uint8Array | null } {
  let isKey = false;
  let sps: Uint8Array | null = null;
  const len = buf.length;
  let i = 0;
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0;
      if (buf[i + 2] === 1) codeLen = 3;
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4;
      if (codeLen) {
        if (i + codeLen >= len) break;
        const nalType = buf[i + codeLen]! & 0x1f;
        if (nalType === 7 && !sps && i + codeLen + 3 < len)
          sps = buf.subarray(i + codeLen, i + codeLen + 4);
        if (nalType === 5) isKey = true;
        i += codeLen + 1;
        continue;
      }
    }
    i++;
  }
  return { isKey, sps };
}

export type AvccChunk = {
  readonly type: "description" | "keyframe" | "delta" | "seed";
  readonly payload: Uint8Array;
};

const AVCC_TAGS = {
  1: "description",
  2: "keyframe",
  3: "delta",
  4: "seed",
} as const;

/** Turns a fragmented AVCC byte stream into complete envelopes. */
export class AvccDemuxer {
  private readonly parser = new AvccEnvelopeParser({ unknownTags: "skip" });

  push(bytes: Uint8Array): AvccChunk[] {
    return Array.from(this.parser.push(bytes), ({ tag, payload }) => ({
      type: AVCC_TAGS[tag],
      payload,
    }));
  }

  end(): void {
    this.parser.end();
  }

  reset(): void {
    this.parser.reset();
  }
}

export interface DeviceStreamClient {
  readonly start: () => void;
  readonly stop: () => void;
  /**
   * Own the displayed MJPEG image's source and frame/error observation.
   * `stop()` detaches it; attach a fresh image for each restart.
   */
  readonly setMjpegImage: (image: HTMLImageElement | null) => void;
  /** Normalized 0..1 coordinates in the displayed frame. */
  readonly sendTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  readonly sendKey: (event: KeyboardEvent, phase: "down" | "up") => void;
  readonly pressButton: (button: DeviceHardwareButton) => void;
  readonly rotate: () => void;
  readonly setOrientation: (orientation: DeviceScreenSize["orientation"]) => void;
  readonly controlDuo: (command: DuoCommand) => void;
  /** Switch between one active feed and two fixed-panel feeds without replacing HID. */
  readonly setDuoPanels: (panels: DuoPanelSinks | null) => void;
  /** Model UVs already map to the hardware framebuffer. */
  readonly sendRawTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
}

const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === "Digit0") return 0x27;
  return HID_USAGE_BY_CODE[code] ?? null;
}

const ANDROID_KEYCODE_BY_KEY: Readonly<Record<string, number>> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

const IOS_ORIENTATIONS: ReadonlyArray<DeviceScreenSize["orientation"]> = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
];

export function createDeviceStreamClient(
  target: DeviceStreamTarget,
  output: HTMLCanvasElement | DeviceFrameSink,
  events: DeviceStreamEvents,
): DeviceStreamClient {
  const { access, platform, deviceId } = target;
  const sink = "present" in output ? output : createCanvasFrameSink(output);
  const vendor = platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";
  const device = encodeURIComponent(deviceId);
  const httpUrl = (path: string) =>
    withDeviceHubQuery(`${access.httpBase}${vendor}${path}`, access);
  const wsUrl = (path: string) => withDeviceHubQuery(`${access.wsBase}${vendor}${path}`, access);
  const useWebCodecs = isWebCodecsSupported() && !(platform === "ios" && target.preferMjpeg);

  let stopped = true;
  let socket: WebSocket | null = null;
  let controller: AbortController | null = null;
  const retryTimers = new Map<"video" | "input", ReturnType<typeof setTimeout>>();
  let primeController: AbortController | null = null;
  let videoDecoder: VideoDecoder | null = null;
  let mediaTransport: ReturnType<typeof createDeviceMediaTransport> | null = null;
  let mediaEpoch = 0;
  let mediaConfigId = 0;
  let recoveringMediaEpoch: number | null = null;
  const submittedFrames = new Map<number, number>();
  let submittedBytes = 0;
  let decodedVideoGeneration: number | null = null;
  let iosInputAdmitted = false;
  let iosInputUnavailable = false;
  let timestamp = 0;
  let awaitingKeyframe = true;
  let keyframeRequested = false;
  let pendingAndroidFrames: ReturnType<typeof parseSemuPacket>[] = [];
  let pendingAndroidBytes = 0;
  let androidConfigurationLost = false;
  let screen: DeviceScreenSize | null = null;
  let firstFrame = false;
  let configuring = false;
  let mjpeg = false;
  let generation = 0;
  let decoderEpoch = 0;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let videoReadTimer: ReturnType<typeof setTimeout> | null = null;
  let mjpegImage: HTMLImageElement | null = null;
  let releaseImage: (() => void) | null = null;
  let videoGeneration = 0;
  let panelClients: DeviceStreamClient[] = [];
  let panelSinks: DuoPanelSinks | null = null;
  let rotationCursor: DeviceScreenSize["orientation"] | null = null;
  let pendingOrientation: { requestId: number } | null = null;
  const duoControl = createDuoControl({
    send(request) {
      if (
        !iosInputAdmitted ||
        iosInputUnavailable ||
        socket?.readyState !== WebSocket.OPEN ||
        !screen?.supportsHingeAngle
      )
        return false;
      if (request.command.control === "physical" && !screen.supportsPhysicalOrientation)
        return false;
      try {
        pendingOrientation = null;
        if (request.command.control === "orientation") {
          const value = request.command.value;
          pendingOrientation = { requestId: request.requestId };
          rotationCursor = value;
          // Upstream serializes orientation with hinge commands, then broadcasts config.
          // An orientation-locked app can keep its framebuffer orientation after the sensor rotates.
          socket.send(taggedJson(IOS_MSG_ORIENTATION, { orientation: value }));
        } else socket.send(taggedJson(0x10, request));
        return true;
      } catch {
        return false;
      }
    },
    onChange(state) {
      if (!state.pending) pendingOrientation = null;
      events.onDuoControl?.(state);
    },
  });
  const videoPath = `/helper/${device}${target.panelId ? `/panel/${target.panelId}` : ""}/stream.avcc`;

  const mjpegUrl = () => httpUrl(`/helper/${device}/stream.mjpeg`);

  const setStatus = (status: DeviceStreamStatus, detail?: string) => {
    if (!stopped) events.onStatus(status, detail);
  };

  const clearFrameTimer = () => {
    if (frameTimer !== null) clearTimeout(frameTimer);
    frameTimer = null;
  };

  const fail = (detail: string) => {
    if (stopped) return;
    stop();
    events.onInputConnected(false, detail);
    events.onStatus("error", detail);
  };

  const connecting = (detail?: string) => {
    firstFrame = false;
    if (frameTimer === null) {
      frameTimer = setTimeout(
        () => fail("No video received from the device. Reconnect to try again."),
        FIRST_FRAME_TIMEOUT_MS,
      );
    }
    setStatus("connecting", detail);
  };

  const frameReceived = () => {
    if (firstFrame) return;
    firstFrame = true;
    clearFrameTimer();
    setStatus("streaming");
  };

  const observeMjpegImage = () => {
    releaseImage?.();
    releaseImage = null;
    const image = mjpegImage;
    if (!image || stopped || !mjpeg) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let released = false;
    const check = () => {
      if (released || stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) frameReceived();
      else {
        // Multipart images may not emit load until the response ends. Stop checking after the first frame.
        timer = setTimeout(check, MJPEG_FRAME_CHECK_MS);
      }
    };
    const error = () => {
      if (!released) fail("Could not receive the device stream. Reconnect to try again.");
    };
    image.addEventListener("load", check);
    image.addEventListener("error", error);
    releaseImage = () => {
      released = true;
      if (timer !== null) clearTimeout(timer);
      image.removeEventListener("load", check);
      image.removeEventListener("error", error);
      image.removeAttribute("src");
    };
    image.src = mjpegUrl();
    check();
  };

  const setMjpegImage = (image: HTMLImageElement | null) => {
    if (mjpegImage === image) return;
    releaseImage?.();
    releaseImage = null;
    mjpegImage = image;
    observeMjpegImage();
  };

  const fallBackToMjpeg = () => {
    if (stopped || mjpeg) return;
    mjpeg = true;
    controller?.abort();
    controller = null;
    mediaTransport?.stop();
    mediaTransport = null;
    closeDecoder();
    connecting();
    events.onMjpegFallback(mjpegUrl());
    if (!releaseImage) observeMjpegImage();
  };

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped) return;
    if (!isDeviceFrameSize(width, height)) {
      fail("The device stream has invalid frame dimensions.");
      return;
    }
    if (platform === "android" && (screen?.width !== width || screen.height !== height)) {
      screen = { width, height, orientation: width > height ? "landscape_left" : "portrait" };
      events.onScreen(screen);
    }
    let presented = false;
    try {
      presented = sink.present(source, width, height);
    } catch {}
    if (!presented) {
      fail("Could not display the device stream. Reconnect to try again.");
      return;
    }
    frameReceived();
  };

  const closeDecoder = () => {
    decoderEpoch++;
    try {
      videoDecoder?.close();
    } catch {
      // Already closed.
    }
    videoDecoder = null;
    configuring = false;
    awaitingKeyframe = true;
    submittedFrames.clear();
    submittedBytes = 0;
    pendingAndroidFrames = [];
    pendingAndroidBytes = 0;
    androidConfigurationLost = false;
  };

  const recoverDecoder = () => {
    if (platform === "ios") {
      closeDecoder();
      if (mediaTransport) {
        recoveringMediaEpoch = mediaEpoch;
        connecting("Video decoder restarted.");
        mediaTransport.recover();
      } else controller?.abort();
    } else {
      closeDecoder();
      connecting("Video decoder restarted.");
      requestKeyframe();
    }
  };

  const makeDecoder = () => {
    const feedGeneration = videoGeneration;
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (
            videoDecoder === decoder &&
            (platform !== "ios" || feedGeneration === videoGeneration)
          ) {
            const bytes = submittedFrames.get(frame.timestamp);
            if (bytes !== undefined) {
              submittedFrames.delete(frame.timestamp);
              submittedBytes -= bytes;
            }
            decodedVideoGeneration = feedGeneration;
            paint(frame, frame.displayWidth, frame.displayHeight);
          }
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (
          stopped ||
          videoDecoder !== decoder ||
          (platform === "ios" && feedGeneration !== videoGeneration)
        )
          return;
        recoverDecoder();
      },
    });
    return decoder;
  };

  /** iOS can fall back to MJPEG when the stream's H.264 profile is unsupported. */
  const configureDecoder = async (
    config: VideoDecoderConfig,
    isCurrent = () => !stopped,
  ): Promise<boolean> => {
    const epoch = decoderEpoch;
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(full).catch(() => ({ supported: false }));
    if (!isCurrent() || epoch !== decoderEpoch) return false;
    if (!support.supported) {
      if (platform === "android") fail(`This browser cannot decode ${config.codec}.`);
      return false;
    }
    try {
      if (!videoDecoder || videoDecoder.state === "closed") videoDecoder = makeDecoder();
      videoDecoder.configure(full);
      return true;
    } catch (cause) {
      if (platform === "android") fail(`Video decoder: ${(cause as Error).message}`);
      return false;
    }
  };

  const decode = (isKey: boolean, data: Uint8Array, pts?: number | null) => {
    if (!videoDecoder || videoDecoder.state !== "configured") return;
    if (awaitingKeyframe && !isKey) return;
    if (
      videoDecoder.decodeQueueSize >= MAX_DECODE_QUEUE ||
      submittedFrames.size >= MAX_DECODE_QUEUE ||
      submittedBytes + data.byteLength > DEVICE_MEDIA_MAX_PACKET_BYTES
    ) {
      if (mediaTransport || platform !== "ios") {
        recoverDecoder();
        return;
      }
      // Native IDRs are spaced by frame count, so an idle simulator may take
      // minutes to produce one. A new AVCC subscription forces a fresh IDR.
      controller?.abort();
      closeDecoder();
      return;
    }
    try {
      awaitingKeyframe = false;
      if (isKey) keyframeRequested = false;
      const frameTimestamp = Math.max(pts ?? timestamp, timestamp);
      submittedFrames.set(frameTimestamp, data.byteLength);
      submittedBytes += data.byteLength;
      videoDecoder.decode(
        new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: frameTimestamp,
          data,
        }),
      );
      timestamp = frameTimestamp + FRAME_DURATION_US;
    } catch {
      recoverDecoder();
    }
  };

  const requestKeyframe = () => {
    if (platform === "android" && !keyframeRequested && socket?.readyState === WebSocket.OPEN) {
      keyframeRequested = true;
      socket.send(JSON.stringify({ type: "reset-video", ack: false }));
    }
  };

  const scheduleRetry = (channel: "video" | "input", run: () => void) => {
    if (stopped || retryTimers.has(channel)) return;
    retryTimers.set(
      channel,
      setTimeout(() => {
        retryTimers.delete(channel);
        run();
      }, RETRY_DELAY_MS),
    );
  };

  const handleUnauthorized = () => {
    stop();
    events.onInputConnected(false);
    events.onUnauthorized();
  };

  const connectIosMedia = () => {
    if (stopped || !access.mediaV1WsBase) return;
    const lifecycle = generation;
    const feedGeneration = ++videoGeneration;
    mediaEpoch = 0;
    mediaConfigId = 0;
    recoveringMediaEpoch = null;
    const query = new URLSearchParams({ device: deviceId });
    if (target.panelId) query.set("panel", String(target.panelId));
    const isCurrent = () =>
      !stopped &&
      generation === lifecycle &&
      videoGeneration === feedGeneration &&
      mediaTransport === transport;
    const transport = createDeviceMediaTransport(
      withDeviceHubQuery(`${access.mediaV1WsBase}?${query}`, access),
      {
        async onPacket(packet) {
          if (!isCurrent()) return;
          if (packet.kind === 1) {
            if (
              packet.epoch < mediaEpoch ||
              (recoveringMediaEpoch !== null && packet.epoch <= recoveringMediaEpoch)
            )
              return;
            closeDecoder();
            mediaEpoch = packet.epoch;
            mediaConfigId = packet.configId;
            recoveringMediaEpoch = null;
            const configured = await configureDecoder(
              { codec: avcCodecString(packet.payload), description: packet.payload },
              isCurrent,
            );
            if (!isCurrent()) return;
            if (!configured) {
              if (target.videoOnly)
                fail(
                  `This browser cannot decode the Duo panel's ${avcCodecString(packet.payload)} stream.`,
                );
              else fallBackToMjpeg();
            }
            return;
          }
          if (packet.kind === 4) {
            if (packet.epoch < mediaEpoch || recoveringMediaEpoch !== null) return;
            const bitmap = await createImageBitmap(
              new Blob([packet.payload as BlobPart], { type: "image/jpeg" }),
            ).catch(() => null);
            if (!bitmap) return;
            try {
              if (isCurrent() && decodedVideoGeneration !== feedGeneration)
                paint(bitmap, bitmap.width, bitmap.height);
            } finally {
              bitmap.close();
            }
            return;
          }
          if (
            recoveringMediaEpoch !== null ||
            packet.epoch !== mediaEpoch ||
            packet.configId !== mediaConfigId
          )
            return;
          decode(packet.kind === 2, packet.payload);
        },
        onClose(code, detail) {
          if (!isCurrent()) return;
          mediaTransport = null;
          closeDecoder();
          if (code === 1008 || code === 4401 || (code === 1006 && access.query.wsTicket))
            return handleUnauthorized();
          connecting(detail);
          scheduleRetry("video", connectIosMedia);
        },
        onError(detail) {
          if (!isCurrent()) return;
          mediaTransport = null;
          closeDecoder();
          if (target.videoOnly) fail(detail);
          else fallBackToMjpeg();
        },
      },
    );
    mediaTransport = transport;
  };

  const startIosVideo = () => {
    if (access.mediaV1WsBase) connectIosMedia();
    else void readIosVideo();
  };

  // iOS video: fetch the AVCC body and demux into the decoder.
  const readIosVideo = async () => {
    const lifecycle = generation;
    const feedGeneration = ++videoGeneration;
    const demuxer = new AvccDemuxer();
    const videoController = new AbortController();
    controller = videoController;
    const isCurrent = () =>
      !stopped &&
      generation === lifecycle &&
      videoGeneration === feedGeneration &&
      controller === videoController;
    let retryDetail: string | undefined;
    try {
      const response = await fetch(httpUrl(videoPath), {
        signal: videoController.signal,
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (!isCurrent()) {
        await response.body?.cancel();
        return;
      }
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      if (target.panelId && [400, 404, 405, 410].includes(response.status)) {
        await response.body?.cancel();
        setStatus("error", "This Device Hub does not provide fixed Duo display feeds.");
        return;
      }
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        // An AVCC body can stay open after its helper stops producing frames.
        const timer = setTimeout(() => {
          if (!isCurrent()) return;
          retryDetail = "Device stream stopped receiving video. Reconnecting…";
          videoController.abort();
        }, FIRST_FRAME_TIMEOUT_MS);
        videoReadTimer = timer;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } finally {
          clearTimeout(timer);
          if (videoReadTimer === timer) videoReadTimer = null;
        }
        const { done, value } = result;
        if (!isCurrent()) return;
        if (done) {
          demuxer.end();
          break;
        }
        for (const chunk of demuxer.push(value)) {
          if (videoController.signal.aborted) break;
          switch (chunk.type) {
            case "seed":
              void createImageBitmap(new Blob([chunk.payload as BlobPart], { type: "image/jpeg" }))
                .then((bitmap) => {
                  try {
                    if (isCurrent() && decodedVideoGeneration !== feedGeneration)
                      paint(bitmap, bitmap.width, bitmap.height);
                  } finally {
                    bitmap.close();
                  }
                })
                .catch(() => {});
              break;
            case "description": {
              awaitingKeyframe = true;
              const configured = await configureDecoder(
                { codec: avcCodecString(chunk.payload), description: chunk.payload },
                isCurrent,
              );
              if (!isCurrent()) return;
              if (!configured) {
                await reader.cancel().catch(() => {});
                if (!isCurrent()) return;
                if (target.videoOnly)
                  setStatus(
                    "error",
                    `This browser cannot decode the Duo panel's ${avcCodecString(chunk.payload)} stream.`,
                  );
                else fallBackToMjpeg();
                return;
              }
              break;
            }
            case "keyframe":
            case "delta":
              decode(chunk.type === "keyframe", chunk.payload);
              break;
          }
        }
      }
    } catch (cause) {
      if (!isCurrent()) return;
      retryDetail ??= videoController.signal.aborted
        ? "Video decoder fell behind. Reconnecting…"
        : (cause as Error).message;
    }
    if (isCurrent()) {
      controller = null;
      videoController.abort();
      closeDecoder();
      connecting(retryDetail);
      scheduleRetry("video", () => void readIosVideo());
    }
  };

  /**
   * serve-sim's helper only accepts HID and pushes its screen config once
   * screen capture is running, and the AVCC stream does not reliably start
   * it. Touching the MJPEG endpoint does; one aborted request is enough.
   */
  const primeIosHelper = async (session: number) => {
    const controller = new AbortController();
    primeController = controller;
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(httpUrl(`/helper/${device}/stream.mjpeg`), {
        signal: controller.signal,
        credentials: access.credentials ? "include" : "same-origin",
      });
      if (stopped || generation !== session) return;
      if (response.status === 401 || response.status === 403) return handleUnauthorized();
      await response.body?.getReader().read();
    } catch {
      // A failed prime just means the socket may take a retry to come up.
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (primeController === controller) primeController = null;
    }
  };

  const startDuoVideo = (panels: DuoPanelSinks) => {
    for (const panel of panelClients) panel.stop();
    // Physical handoff elects a native surface. Fixed-panel encoders can keep
    // an inactive shutdown frame after election, so this build uses one active
    // feed instead of decoding a third stream alongside the two fixed feeds.
    const ids = screen?.supportsPhysicalOrientation ? ([null] as const) : ([1, 3] as const);
    panelClients = ids.map((id) => {
      const output = id === 1 ? panels.cover : panels.inner;
      return createDeviceStreamClient(
        { ...target, ...(id === null ? {} : { panelId: id }), videoOnly: true },
        {
          present(source, width, height) {
            if (id === null) {
              return sink.present(source, width, height);
            }
            // An inactive native LCD can emit its shutdown black frame. Retain its last useful image.
            if (screen?.screenId !== id) return true;
            const retained = output.present(source, width, height);
            const primary = sink.present(source, width, height);
            return retained && primary;
          },
        },
        {
          onStatus: (status, detail) => {
            if (status === "error") events.onDuoUnavailable?.(detail);
          },
          onScreen: () => {},
          onInputConnected: () => {},
          onMjpegFallback: () => {},
          onUnauthorized: handleUnauthorized,
        },
      );
    });
    for (const panel of panelClients) panel.start();
  };

  // iOS input socket; also carries the screen config the helper pushes.
  const connectIosInput = async () => {
    if (stopped) return;
    const session = generation;
    await primeIosHelper(session);
    if (stopped || generation !== session) return;
    const ws = new WebSocket(wsUrl(`/helper/ws?device=${device}`));
    ws.binaryType = "arraybuffer";
    socket = ws;
    iosInputAdmitted = false;
    iosInputUnavailable = false;
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (socket !== ws || stopped || bytes.length < 1) return;
      if (bytes[0] === IOS_TAG_INPUT_ADMITTED) {
        iosInputAdmitted = true;
        events.onInputConnected(!iosInputUnavailable);
        return;
      }
      try {
        const payload: unknown = JSON.parse(decoder.decode(bytes.subarray(1)));
        if (bytes[0] === 0x90) {
          const reply = decodeControlReply(payload);
          if (Option.isSome(reply)) duoControl.receive(reply.value);
        } else if (bytes[0] === IOS_TAG_SCREEN_CONFIG) {
          const config = decodeScreenConfig(payload);
          if (Option.isSome(config)) {
            iosInputUnavailable = config.value.inputUnavailable === true;
            events.onInputConnected(
              iosInputAdmitted && !iosInputUnavailable,
              iosInputUnavailable ? "Simulator input is unavailable" : undefined,
            );
            const previous = screen;
            screen = config.value;
            if (screen.hingePose && screen.hingePose !== previous?.hingePose)
              rotationCursor = screen.hingePose === "laptop" ? "landscape_left" : "portrait";
            else if (screen.orientation !== previous?.orientation)
              rotationCursor = screen.orientation;
            panelSinks?.onScreen?.(screen);
            events.onScreen(screen);
            // A surface election can leave an existing decoder on the former
            // encoder description. Reopen only video to acquire the elected
            // surface's seed and codec configuration; HID and the viewer stay.
            if (
              panelSinks &&
              screen.supportsPhysicalOrientation &&
              previous &&
              screen.screenId !== previous.screenId
            )
              startDuoVideo(panelSinks);
            if (pendingOrientation) {
              const receipt = pendingOrientation;
              pendingOrientation = null;
              duoControl.receive({
                requestId: receipt.requestId,
                ok: true,
              });
            }
          }
        }
      } catch {
        // Ignore malformed config frames.
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      iosInputAdmitted = false;
      duoControl.clear();
      rotationCursor = null;
      if (stopped) return;
      events.onInputConnected(
        false,
        event.reason || (event.code === 1006 ? "input socket refused" : `closed ${event.code}`),
      );
      // A rejected HTTP upgrade surfaces as 1006, including an expired stream ticket.
      if (
        event.code === 1008 ||
        event.code === 4401 ||
        (event.code === 1006 && access.query.wsTicket)
      )
        return handleUnauthorized();
      scheduleRetry("input", () => void connectIosInput());
    };
    ws.onerror = () => ws.close();
  };

  // Android: one socket for video and input.
  const connectAndroid = () => {
    if (stopped) return;
    const ws = new WebSocket(wsUrl(`/ws?device=${device}&frame-meta=1`));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      connecting();
      events.onInputConnected(true);
    };
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      if (typeof event.data === "string") {
        // The encoder restarts at a new size when the device rotates; the
        // next keyframe carries a fresh SPS, so the decoder is rebuilt from it.
        if (isVideoSessionMessage(event.data)) {
          closeDecoder();
          configuring = false;
          keyframeRequested = false;
          connecting();
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      let packet: ReturnType<typeof parseSemuPacket>;
      try {
        packet = parseSemuPacket(event.data);
      } catch {
        recoverDecoder();
        return;
      }
      const needsScan =
        packet.isKey === null ||
        (packet.isKey && (!videoDecoder || videoDecoder.state !== "configured"));
      const scanned = needsScan ? scanAccessUnit(packet.data) : null;
      const isKey = packet.isKey ?? scanned?.isKey ?? false;
      if (configuring) {
        if (androidConfigurationLost) return;
        if (isKey) {
          pendingAndroidFrames = [];
          pendingAndroidBytes = 0;
        }
        if (pendingAndroidFrames.length === 0 && !isKey) return;
        if (
          pendingAndroidFrames.length >= MAX_DECODE_QUEUE ||
          pendingAndroidBytes + packet.data.byteLength > DEVICE_MEDIA_MAX_PACKET_BYTES
        ) {
          pendingAndroidFrames = [];
          pendingAndroidBytes = 0;
          androidConfigurationLost = true;
          return;
        }
        pendingAndroidFrames.push({ ...packet, isKey });
        pendingAndroidBytes += packet.data.byteLength;
        return;
      }
      if (scanned?.sps && (!videoDecoder || videoDecoder.state !== "configured")) {
        configuring = true;
        pendingAndroidFrames = isKey ? [{ ...packet, isKey }] : [];
        pendingAndroidBytes = isKey ? packet.data.byteLength : 0;
        androidConfigurationLost = false;
        const epoch = decoderEpoch;
        const isCurrent = () => !stopped && socket === ws;
        void configureDecoder({ codec: avcCodecString(scanned.sps) }, isCurrent).then(
          (configured) => {
            if (!isCurrent() || epoch !== decoderEpoch) return;
            configuring = false;
            awaitingKeyframe = true;
            const pending = pendingAndroidFrames;
            pendingAndroidFrames = [];
            pendingAndroidBytes = 0;
            if (configured) {
              if (androidConfigurationLost || pending.length === 0) requestKeyframe();
              else
                for (const frame of pending)
                  decode(frame.isKey === true, frame.data, frame.timestamp);
            }
          },
        );
        return;
      }
      if (!videoDecoder || videoDecoder.state !== "configured") {
        if (!isKey) requestKeyframe();
        return;
      }
      decode(isKey, packet.data, packet.timestamp);
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      closeDecoder();
      if (stopped) return;
      events.onInputConnected(false, event.reason || `closed ${event.code}`);
      if (
        event.code === 1008 ||
        event.code === 4401 ||
        (event.code === 1006 && access.query.wsTicket)
      )
        return handleUnauthorized();
      configuring = false;
      connecting(event.reason || undefined);
      scheduleRetry("input", connectAndroid);
    };
    ws.onerror = () => ws.close();
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    generation++;
    configuring = false;
    keyframeRequested = false;
    iosInputAdmitted = false;
    iosInputUnavailable = false;
    connecting();
    if (platform === "ios") {
      if (!target.videoOnly) void connectIosInput();
      if (useWebCodecs) startIosVideo();
      else fallBackToMjpeg();
    } else if (useWebCodecs) {
      connectAndroid();
    } else {
      fail("This browser cannot decode the Android stream (WebCodecs unavailable).");
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    videoGeneration++;
    duoControl.clear();
    rotationCursor = null;
    for (const panel of panelClients) panel.stop();
    panelClients = [];
    panelSinks = null;
    mjpeg = false;
    clearFrameTimer();
    if (videoReadTimer !== null) clearTimeout(videoReadTimer);
    videoReadTimer = null;
    releaseImage?.();
    releaseImage = null;
    mjpegImage = null;
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    primeController?.abort();
    primeController = null;
    controller?.abort();
    controller = null;
    mediaTransport?.stop();
    mediaTransport = null;
    const discarded = socket;
    socket = null;
    discarded?.close();
    closeDecoder();
  };

  const send = (payload: Uint8Array<ArrayBuffer> | string) => {
    if (
      !stopped &&
      (platform !== "ios" || (iosInputAdmitted && !iosInputUnavailable)) &&
      socket?.readyState === WebSocket.OPEN
    )
      socket.send(payload);
  };

  const rawPoint = (x: number, y: number) => {
    // serve-sim streams the raw framebuffer; rotated devices need input
    // remapped into that raw space.
    if (platform !== "ios" || !screen || screen.width > screen.height) return { x, y };
    switch (screen.orientation) {
      case "landscape_left":
        return { x: y, y: 1 - x };
      case "landscape_right":
        return { x: 1 - y, y: x };
      case "portrait_upside_down":
        return { x: 1 - x, y: 1 - y };
      default:
        return { x, y };
    }
  };

  return {
    start,
    stop,
    setMjpegImage,
    controlDuo: duoControl.enqueue,
    sendRawTouch: (phase, x, y) => {
      if (platform === "ios") send(taggedJson(IOS_MSG_TOUCH, { type: phase, x, y }));
    },
    setDuoPanels(panels) {
      if (platform !== "ios" || target.videoOnly || stopped || panelSinks === panels) return;
      if (panels && !screen?.supportsHingeAngle) return;
      panelSinks = panels;
      videoGeneration++;
      controller?.abort();
      controller = null;
      mediaTransport?.stop();
      mediaTransport = null;
      closeDecoder();
      const retry = retryTimers.get("video");
      if (retry) clearTimeout(retry);
      retryTimers.delete("video");
      for (const panel of panelClients) panel.stop();
      panelClients = [];
      if (!panels) {
        if (useWebCodecs) startIosVideo();
        return;
      }
      startDuoVideo(panels);
    },
    sendTouch: (phase, x, y) => {
      if (platform === "ios") {
        send(taggedJson(IOS_MSG_TOUCH, { type: phase, ...rawPoint(x, y) }));
        return;
      }
      const action = phase === "begin" ? "down" : phase === "move" ? "move" : "up";
      send(JSON.stringify({ type: "touch", action, x, y }));
    },
    sendKey: (event, phase) => {
      if (platform === "ios") {
        const usage = hidUsageForCode(event.code);
        if (usage !== null) send(taggedJson(IOS_MSG_KEY, { type: phase, usage }));
        return;
      }
      if (phase !== "down") return;
      if (event.key === "Escape") return send(JSON.stringify({ type: "back" }));
      const keycode = ANDROID_KEYCODE_BY_KEY[event.key];
      if (keycode !== undefined) return send(JSON.stringify({ type: "key", keycode }));
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        send(JSON.stringify({ type: "text", text: event.key }));
      }
    },
    pressButton: (button) => {
      if (platform === "ios") {
        const name =
          button === "home"
            ? "home"
            : button === "appSwitcher"
              ? "app_switcher"
              : button === "power"
                ? "lock"
                : null;
        if (name) send(taggedJson(IOS_MSG_BUTTON, { button: name }));
        return;
      }
      const type = button === "appSwitcher" ? "recents" : button;
      if (type === "home" || type === "back" || type === "recents" || type === "power") {
        send(JSON.stringify({ type }));
      }
    },
    rotate: () => {
      if (platform !== "ios") return;
      const current = screen?.supportsHingeAngle
        ? (rotationCursor ?? screen.orientation)
        : (screen?.orientation ?? "portrait");
      const next =
        IOS_ORIENTATIONS[(IOS_ORIENTATIONS.indexOf(current) + 1) % IOS_ORIENTATIONS.length]!;
      if (screen?.supportsHingeAngle) {
        rotationCursor = next;
        duoControl.enqueue({ control: "orientation", value: next });
      } else send(taggedJson(IOS_MSG_ORIENTATION, { orientation: next }));
    },
    setOrientation: (orientation) => {
      if (platform === "ios") send(taggedJson(IOS_MSG_ORIENTATION, { orientation }));
    },
  };
}
