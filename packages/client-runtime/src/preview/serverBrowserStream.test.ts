import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewStreamClient,
  createPreviewFramePainter,
  resolvePreviewStreamDownload,
  type PreviewStreamControl,
  uploadPreviewStreamFiles,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  closed(code: number) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
  hello() {
    this.open();
    this.message(JSON.stringify({ type: "hello", version: 2, codec: "jpeg" }));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.hello();
    FakeSocket.current.sent.length = 0;
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("marks passive viewers without changing active viewer URLs", () => {
    const { client, socket } = connect();
    expect(new URL(socket.url).searchParams.has("interactive")).toBe(false);
    client.stop();
    const passive = createPreviewStreamClient(
      { ...target, interactive: false },
      {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    expect(new URL(FakeSocket.current.url).searchParams.get("interactive")).toBe("false");
    passive.stop();
  });

  it("does not resize or navigate before ownership is granted", () => {
    const { client, socket } = connect();
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "navigate", url: "http://example.test" })).toBe(false);
    socket.control(agent);
    expect(client.send({ type: "takeControl" })).toBe(true);
    expect(client.send({ type: "text", text: "premature" })).toBe(false);
    socket.control({ ...agent, controller: "you", generation: 2 });
    expect(client.send({ type: "text", text: "owned" })).toBe(true);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "takeControl" },
      { type: "text", text: "owned" },
    ]);
    client.stop();
  });

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream transfers", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download descriptor without embedding the stream's expiring ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.hello();
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      id: "d1",
      fileName: "a b.csv",
      sizeBytes: 3,
    });
  });

  it("resolves download URLs with access refreshed at save time", async () => {
    const resolveAccess = vi.fn(async () => ({
      httpBase: "http://preview.test/api/preview-stream",
      wsBase: "ws://preview.test/api/preview-stream",
      query: { wsTicket: "fresh-ticket" },
      credentials: false,
    }));

    await expect(
      resolvePreviewStreamDownload(
        { id: "d1" },
        { threadId: "thread", tabId: "tab", resolveAccess },
      ),
    ).resolves.toBe(
      "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=fresh-ticket",
    );
    expect(resolveAccess).toHaveBeenCalledOnce();
  });

  it("resolves upload access after the user finishes choosing files", async () => {
    const resolveAccess = vi.fn(async () => ({
      httpBase: "http://preview.test/api/preview-stream",
      wsBase: "ws://preview.test/api/preview-stream",
      query: { wsTicket: "fresh-ticket" },
      credentials: false,
    }));
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadPreviewStreamFiles(
      { id: "chooser-1", multiple: true, accept: ".csv" },
      [new Blob(["file contents"], { type: "text/csv" })],
      { threadId: "thread", tabId: "tab", resolveAccess },
    );

    expect(resolveAccess).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://preview.test/api/preview-stream/upload?threadId=thread&tabId=tab&chooser=chooser-1&wsTicket=fresh-ticket",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "omit",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.hello();
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});

describe("preview stream delivery", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const events = (onFrame: (frame: ArrayBuffer) => void | Promise<void> = vi.fn()) => ({
    onFrame,
    onViewport: vi.fn(),
    onConnectedChange: vi.fn(),
    onUnauthorized: vi.fn(),
  });

  it("requires a server hello before delivering frames or announcing readiness", () => {
    const callbacks = events();
    const client = createPreviewStreamClient(target, callbacks);
    const socket = FakeSocket.current;
    expect(new URL(socket.url).pathname).toBe("/api/preview-stream/ws/v2");
    socket.open();
    socket.message(new ArrayBuffer(4));
    expect(callbacks.onConnectedChange).not.toHaveBeenCalled();
    expect(callbacks.onFrame).not.toHaveBeenCalled();
    socket.message(JSON.stringify({ type: "hello", version: 2, codec: "jpeg" }));
    expect(socket.sent).toEqual(['{"type":"ready","version":2,"visible":true}']);
    expect(callbacks.onConnectedChange).toHaveBeenCalledExactlyOnceWith(true);
    client.stop();
  });

  it("falls back once when an older server does not have the versioned route", () => {
    const callbacks = events();
    const client = createPreviewStreamClient(
      { ...target, access: { ...target.access, query: { wsTicket: "ticket" } } },
      callbacks,
    );
    FakeSocket.current.closed(1006);
    const legacy = FakeSocket.current;
    expect(new URL(legacy.url).pathname).toBe("/api/preview-stream/ws");
    expect(new URL(legacy.url).searchParams.get("wsTicket")).toBe("ticket");
    legacy.open();
    legacy.message(new ArrayBuffer(4));
    expect(callbacks.onFrame).toHaveBeenCalledOnce();
    expect(legacy.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("reports an explicit authorization failure without retrying another protocol", () => {
    const callbacks = events();
    const client = createPreviewStreamClient(target, callbacks);
    const socket = FakeSocket.current;
    socket.closed(1008);
    expect(FakeSocket.current).toBe(socket);
    expect(callbacks.onUnauthorized).toHaveBeenCalledOnce();
    client.stop();
  });

  it("falls back when an upgraded server never sends a compatible hello", () => {
    vi.useFakeTimers();
    const client = createPreviewStreamClient(target, events());
    const socket = FakeSocket.current;
    socket.open();
    vi.advanceTimersByTime(5000);
    expect(socket.readyState).toBe(3);
    socket.closed(1002);
    expect(new URL(FakeSocket.current.url).pathname).toBe("/api/preview-stream/ws");
    client.stop();
  });

  it("returns a frame credit only after the renderer finishes, including decode failure", async () => {
    const rendered = Promise.withResolvers<void>();
    const client = createPreviewStreamClient(
      target,
      events(() => rendered.promise),
    );
    const socket = FakeSocket.current;
    socket.hello();
    socket.sent.length = 0;
    socket.message(new ArrayBuffer(4));
    expect(socket.sent).toEqual([]);
    rendered.reject(new Error("decode failed"));
    await rendered.promise.catch(() => undefined);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("clears the handshake deadline when stopped before negotiation finishes", () => {
    vi.useFakeTimers();
    const client = createPreviewStreamClient(target, events());
    FakeSocket.current.open();
    expect(vi.getTimerCount()).toBe(1);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not acknowledge a finished render on a replacement socket", async () => {
    vi.useFakeTimers();
    const rendered = Promise.withResolvers<void>();
    const client = createPreviewStreamClient(
      target,
      events(() => rendered.promise),
    );
    const first = FakeSocket.current;
    first.hello();
    first.sent.length = 0;
    first.message(new ArrayBuffer(4));
    first.closed(1012);
    vi.advanceTimersByTime(500);
    const replacement = FakeSocket.current;
    replacement.hello();
    replacement.sent.length = 0;
    rendered.resolve();
    await rendered.promise;
    expect(first.sent).toEqual([]);
    expect(replacement.sent).toEqual([]);
    client.stop();
  });

  it("pauses hidden viewers, discards late frames, and resumes on the same connection", () => {
    const page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal("document", page);
    const callbacks = events();
    const client = createPreviewStreamClient(target, callbacks);
    const socket = FakeSocket.current;
    socket.hello();
    socket.sent.length = 0;
    page.hidden = true;
    page.dispatchEvent(new Event("visibilitychange"));
    socket.message(new ArrayBuffer(4));
    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    expect(callbacks.onFrame).not.toHaveBeenCalled();
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: "visibility", visible: false },
      { type: "ack" },
      { type: "visibility", visible: true },
    ]);
    expect(FakeSocket.current).toBe(socket);
    client.stop();
    page.dispatchEvent(new Event("visibilitychange"));
    expect(socket.sent).toHaveLength(3);
  });

  it("keeps a floating player rendering while its document is hidden", () => {
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: true }));
    const callbacks = events();
    const client = createPreviewStreamClient({ ...target, keepAliveWhenHidden: true }, callbacks);
    FakeSocket.current.hello();
    FakeSocket.current.message(new ArrayBuffer(4));
    expect(callbacks.onFrame).toHaveBeenCalledOnce();
    expect(JSON.parse(FakeSocket.current.sent[0]!)).toMatchObject({ visible: true });
    client.stop();
  });
});

describe("preview frame painter", () => {
  afterEach(() => vi.unstubAllGlobals());
  const setup = () => {
    const decoded: Array<PromiseWithResolvers<ImageBitmap>> = [];
    const createBitmap = vi.fn(() => {
      const result = Promise.withResolvers<ImageBitmap>();
      decoded.push(result);
      return result.promise;
    });
    vi.stubGlobal("createImageBitmap", createBitmap);
    const context = { drawImage: vi.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const painted = vi.fn();
    const painter = createPreviewFramePainter(canvas, painted);
    const bitmap = () => ({ width: 800, height: 600, close: vi.fn() }) as unknown as ImageBitmap;
    return { decoded, createBitmap, context, canvas, painter, bitmap, painted };
  };

  it("decodes one frame at a time and releases replaced frames without painting them", async () => {
    const { decoded, createBitmap, context, canvas, painter, bitmap } = setup();
    const first = painter.paint(new ArrayBuffer(1));
    const replaced = painter.paint(new ArrayBuffer(2));
    const latest = painter.paint(new ArrayBuffer(3));
    await replaced;
    expect(createBitmap).toHaveBeenCalledOnce();
    const firstBitmap = bitmap();
    decoded[0]!.resolve(firstBitmap);
    await first;
    expect(createBitmap).toHaveBeenCalledTimes(2);
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(firstBitmap, 0, 0);
    expect(firstBitmap.close).toHaveBeenCalledOnce();
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    decoded[1]!.resolve(bitmap());
    await latest;
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    painter.stop();
  });

  it("releases active and pending frames on stop and closes a late decoded bitmap", async () => {
    const { decoded, context, painter, bitmap, painted } = setup();
    const active = painter.paint(new ArrayBuffer(1));
    const waiting = painter.paint(new ArrayBuffer(2));
    painter.stop();
    await Promise.all([active, waiting, painter.paint(new ArrayBuffer(3))]);
    const late = bitmap();
    decoded[0]!.resolve(late);
    await decoded[0]!.promise;
    expect(late.close).toHaveBeenCalledOnce();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(painted).not.toHaveBeenCalled();
  });
});
