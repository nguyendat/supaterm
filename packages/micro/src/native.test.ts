import * as NodeEvents from "node:events";
import type { Device } from "node-hid";
import type { DesktopMicroBridge, DesktopMicroEvent } from "@supacode/contracts/desktopMicro";
import { describe, expect, it, vi } from "vite-plus/test";
import { MicroController } from "./controller.ts";
import { DesktopMicroHid } from "./desktopHid.ts";
import { MicroUnavailableError } from "./hid.ts";
import { NativeMicro } from "./native.ts";
import { encodeReports, MICRO_VENDOR_ID, MICRO_PRODUCT_ID, ReportDecoder } from "./protocol.ts";

const device = (path: string, release = 1): Device => ({
  path,
  release,
  vendorId: MICRO_VENDOR_ID,
  productId: MICRO_PRODUCT_ID,
  usagePage: 0xff00,
  interface: -1,
  product: "Codex Micro",
});

class Handle extends NodeEvents.EventEmitter {
  close = vi.fn(async () => {});
  write = vi.fn(async (_data: number[]) => 64);
  report(message: object) {
    for (const data of encodeReports(message)) this.emit("data", Uint8Array.from([6, ...data]));
  }
}

function fixture(devices = [device("bluetooth")]) {
  const handle = new Handle();
  const events: DesktopMicroEvent[] = [];
  const listeners = new Set<(event: DesktopMicroEvent) => void>();
  const open = vi.fn(async (_path: string, _options: { nonExclusive: boolean }) => handle);
  const enumerate = vi.fn(async (_vendor: number, _product: number) => devices);
  const micro = new NativeMicro(
    (event) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
    async () => ({ devicesAsync: enumerate, HIDAsync: { open } }),
  );
  const bridge: DesktopMicroBridge = {
    open: () =>
      micro.open().catch((error) => {
        if (error instanceof MicroUnavailableError) return null;
        throw error;
      }),
    stop: () => micro.dispose(),
    close: (id) => micro.close(id),
    write: (id, data) => micro.write(id, data),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { micro, handle, events, open, enumerate, bridge, listeners };
}

describe("native Micro transport", () => {
  it("opens the Bluetooth vendor interface non-exclusively and frames reports", async () => {
    const f = fixture([{ ...device("keyboard"), usagePage: 1 }, device("bluetooth")]);
    const info = await f.micro.open();
    expect(info.transport).toBe("Bluetooth");
    expect(f.enumerate).toHaveBeenCalledExactlyOnceWith(MICRO_VENDOR_ID, MICRO_PRODUCT_ID);
    expect(f.open).toHaveBeenCalledExactlyOnceWith("bluetooth", { nonExclusive: true });
    const data = encodeReports({ method: "device.status", id: 1 })[0]!;
    await f.micro.write(info.id, data);
    expect(f.handle.write).toHaveBeenCalledWith([6, ...data]);
    f.handle.report({ id: 1, result: { version: "1.0" } });
    expect(f.events[0]).toMatchObject({ type: "report", id: info.id });
    f.handle.emit("data", Uint8Array.from([1, 0]));
    expect(f.events).toHaveLength(1);
    await f.micro.dispose();
    expect(f.handle.close).toHaveBeenCalledOnce();
  });

  it("prefers the USB interface when both transports are present", async () => {
    const f = fixture([device("bluetooth"), device("usb", 0)]);
    expect((await f.micro.open()).transport).toBe("USB");
    expect(f.open).toHaveBeenCalledWith("usb", { nonExclusive: true });
    await f.micro.dispose();
  });

  it("never opens another device or its keyboard collection", async () => {
    const f = fixture([
      { ...device("other"), vendorId: 1 },
      { ...device("keyboard"), usagePage: 1 },
    ]);
    await expect(f.micro.open()).rejects.toThrow("No Micro found");
    expect(f.open).not.toHaveBeenCalled();
  });

  it("rejects stale sessions and oversized reports", async () => {
    const f = fixture();
    const info = await f.micro.open();
    await expect(f.micro.write("stale", new Uint8Array(63))).rejects.toThrow("disconnected");
    await expect(f.micro.write(info.id, new Uint8Array(64))).rejects.toThrow("length");
    await f.micro.close("stale");
    expect(f.handle.close).not.toHaveBeenCalled();
    await f.micro.dispose();
  });

  it("rejects partial native writes", async () => {
    const f = fixture();
    const info = await f.micro.open();
    f.handle.write.mockResolvedValue(32);
    await expect(f.micro.write(info.id, new Uint8Array(63))).rejects.toThrow("complete report");
    await f.micro.dispose();
  });

  it("closes a device that finishes opening after its window is disposed", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<Handle>();
    f.open.mockImplementation(() => {
      started.resolve();
      return opening.promise;
    });
    const pending = f.micro.open();
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await started.promise;
    const disposed = f.micro.dispose();
    opening.resolve(f.handle);
    await Promise.all([disposed, rejected]);
    expect(f.handle.close).toHaveBeenCalledOnce();
    expect(f.handle.listenerCount("data")).toBe(0);
  });

  it("does not start a second connection while the first is opening", async () => {
    const f = fixture();
    const pending = f.micro.open();
    await expect(f.micro.open()).rejects.toThrow("already");
    await pending;
    expect(f.open).toHaveBeenCalledOnce();
    await f.micro.dispose();
  });

  it("waits for the previous native handle to close before reopening", async () => {
    const f = fixture();
    const first = await f.micro.open();
    const closing = Promise.withResolvers<void>();
    f.handle.close.mockImplementationOnce(() => closing.promise);
    const closed = f.micro.close(first.id);
    const reopening = f.micro.open();
    expect(f.open).toHaveBeenCalledOnce();
    closing.resolve();
    await closed;
    const second = await reopening;
    expect(second.id).not.toBe(first.id);
    await f.micro.close(first.id);
    expect(f.handle.close).toHaveBeenCalledOnce();
    await f.micro.dispose();
  });

  it("runs the Bluetooth handshake, key actions, and disconnect through the renderer adapter", async () => {
    const f = fixture();
    const decoder = new ReportDecoder();
    const lit = Promise.withResolvers<void>();
    f.handle.write.mockImplementation(async (bytes) => {
      const data = Uint8Array.from(bytes.slice(1));
      for (const message of decoder.read(bytes[0]!, new DataView(data.buffer))) {
        if (message.method === "device.status")
          f.handle.report({ id: message.id, result: { version: "1.0" } });
        else if (message.method === "v.oai.thstatus") lit.resolve();
      }
      return bytes.length;
    });
    const controller = new MicroController(new DesktopMicroHid(f.bridge));
    const action = vi.fn();
    controller.subscribeActions(action);
    await controller.connect();
    await lit.promise;
    expect(controller.getSnapshot()).toMatchObject({
      phase: "connected",
      transport: "Bluetooth",
      firmware: "1.0",
    });
    f.handle.report({ m: "v.oai.hid", p: { k: "ACT07", act: 1 } });
    expect(action).toHaveBeenCalledExactlyOnceWith({ type: "approve" });
    const disconnected = Promise.withResolvers<void>();
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().phase === "disconnected") disconnected.resolve();
    });
    f.handle.emit("error", new Error("Bluetooth disconnected"));
    await disconnected.promise;
    unsubscribe();
    await f.micro.dispose();
    expect(controller.getSnapshot().transport).toBeNull();
    expect(f.handle.close).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });

  it("cleans the renderer listener when native discovery fails", async () => {
    const f = fixture([]);
    const controller = new MicroController(new DesktopMicroHid(f.bridge));
    await controller.connect();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "waiting",
      error: expect.stringContaining("No Micro found"),
    });
    expect(f.listeners.size).toBe(0);
  });

  it("handles a disconnect event delivered before the open result", async () => {
    const f = fixture();
    f.bridge.open = async () => {
      const info = await f.micro.open();
      const disconnected = Promise.withResolvers<void>();
      const unsubscribe = f.bridge.onEvent((event) => {
        if (event.type === "disconnected") disconnected.resolve();
      });
      for (let index = 0; index < 40; index++)
        f.handle.report({ m: "v.oai.hid", p: { k: "ACT07", act: 1 } });
      f.handle.emit("error", new Error("disconnected"));
      await disconnected.promise;
      unsubscribe();
      return info;
    };
    const controller = new MicroController(new DesktopMicroHid(f.bridge));
    await controller.connect();
    expect(controller.getSnapshot().phase).toBe("error");
    expect(f.listeners.size).toBe(0);
    await f.micro.dispose();
  });
});
