import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopMicroBridge, DesktopMicroEvent } from "@supacode/contracts/desktopMicro";
import type { MicroInterface, MicroTopology } from "./topology.ts";
import { MicroUnavailableError } from "./hid.ts";
import { NativeMicro } from "./native.ts";
import { DesktopMicroHid } from "./desktopHid.ts";
import { MicroController } from "./controller.ts";
import { encodeReports, ReportDecoder } from "./protocol.ts";

const usb: MicroInterface = {
  path: "usb",
  vendorId: 0x303a,
  productId: 0x8360,
  usagePage: 0xff00,
  release: 1,
  product: "Micro",
  transport: "USB",
};
const bluetooth: MicroInterface = { ...usb, path: "bluetooth", release: 0, transport: "Bluetooth" };

function fixture(initial: readonly MicroInterface[] = []) {
  let devices = initial;
  let changed: (() => void) | undefined;
  const discovery = vi.fn(async () => devices);
  const unwatch = vi.fn(() => {
    changed = undefined;
  });
  const topology: MicroTopology = {
    find: discovery,
    watch: (listener) => {
      changed = listener;
      return unwatch;
    },
  };
  const listeners = new Set<(event: DesktopMicroEvent) => void>();
  const handles: Array<
    NodeEvents.EventEmitter & { close: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
  > = [];
  const open = vi.fn(async (_path: string) => {
    const handle = Object.assign(new NodeEvents.EventEmitter(), {
      close: vi.fn(async () => {}),
      write: vi.fn(async (bytes: number[]) => {
        const data = Uint8Array.from(bytes.slice(1));
        for (const message of decoder.read(6, new DataView(data.buffer))) {
          if (message.method === "device.status")
            for (const report of encodeReports({ id: message.id, result: { version: "1.0" } }))
              handle.emit("data", Uint8Array.from([6, ...report]));
        }
        return bytes.length;
      }),
    });
    const decoder = new ReportDecoder();
    handles.push(handle);
    return handle;
  });
  const enumerate = vi.fn(async () => []);
  const native = new NativeMicro(
    (event) => {
      for (const listener of listeners) listener(event);
    },
    async () => ({ devicesAsync: enumerate, HIDAsync: { open } }),
    topology,
  );
  const bridge: DesktopMicroBridge = {
    supportsTopology: true,
    open: () =>
      native.open().catch((error) => {
        if (error instanceof MicroUnavailableError) return null;
        throw error;
      }),
    close: (id) => native.close(id),
    write: (id, data) => native.write(id, data),
    stop: () => native.dispose(),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const controller = new MicroController(new DesktopMicroHid(bridge));
  const update = (next: readonly MicroInterface[]) => {
    devices = next;
    changed?.();
  };
  const until = (predicate: () => boolean) => {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const unsubscribe = controller.subscribe(() => {
        if (predicate()) {
          unsubscribe();
          resolve();
        }
      });
    });
  };
  return {
    controller,
    native,
    update,
    until,
    handles,
    open,
    enumerate,
    discovery,
    unwatch,
    listeners,
  };
}

afterEach(() => vi.useRealTimers());

describe("Micro native topology", () => {
  it("uses registry discovery and the actual transport instead of release bits", async () => {
    const f = fixture([bluetooth, usb]);
    await f.controller.connect();
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: "connected",
      transport: "USB",
      enabled: true,
    });
    expect(f.open).toHaveBeenCalledWith("usb", { nonExclusive: true });
    expect(f.enumerate).not.toHaveBeenCalled();
    await f.controller.disconnect();
  });

  it("connects when an armed device arrives and waits again after removal", async () => {
    const f = fixture();
    await f.controller.connect();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "waiting", enabled: true });
    const connected = f.until(() => f.controller.getSnapshot().phase === "connected");
    f.update([bluetooth]);
    await connected;
    expect(f.controller.getSnapshot().transport).toBe("Bluetooth");
    const removed = f.until(() => f.controller.getSnapshot().phase === "waiting");
    f.update([]);
    await removed;
    expect(f.handles[0]!.close).toHaveBeenCalledOnce();
    const reconnected = f.until(() => f.controller.getSnapshot().phase === "connected");
    f.update([bluetooth]);
    await reconnected;
    expect(f.handles).toHaveLength(2);
    await f.controller.disconnect();
  });

  it("hands Bluetooth over to USB and falls back when the cable is removed", async () => {
    const f = fixture([bluetooth]);
    await f.controller.connect();
    const wired = f.until(() => f.controller.getSnapshot().transport === "USB");
    f.update([bluetooth, usb]);
    await wired;
    expect(f.handles[0]!.close).toHaveBeenCalledOnce();
    const wireless = f.until(() => f.controller.getSnapshot().transport === "Bluetooth");
    f.update([bluetooth]);
    await wireless;
    expect(f.handles[1]!.close).toHaveBeenCalledOnce();
    expect(f.open.mock.calls.map((call) => call[0])).toEqual(["bluetooth", "usb", "bluetooth"]);
    await f.controller.disconnect();
  });

  it("manual disconnect disables arrival handling and releases the watcher", async () => {
    const f = fixture([bluetooth]);
    await f.controller.connect();
    await f.controller.disconnect();
    expect(f.unwatch).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
    f.update([usb]);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "disconnected", enabled: false });
  });

  it("honors manual disconnect during automatic recovery", async () => {
    const f = fixture([bluetooth]);
    await f.controller.connect();
    const stopped = Promise.withResolvers<void>();
    const unsubscribe = f.controller.subscribe(() => {
      const snapshot = f.controller.getSnapshot();
      if (snapshot.phase === "disconnecting" && snapshot.enabled) {
        void f.controller.disconnect().then(stopped.resolve, stopped.reject);
      }
    });
    f.update([usb]);
    await stopped.promise;
    unsubscribe();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "disconnected", enabled: false });
    expect(f.unwatch).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
    f.update([bluetooth]);
    expect(f.open).toHaveBeenCalledOnce();
  });

  it("coalesces device notifications while discovery is running", async () => {
    const f = fixture([bluetooth]);
    await f.controller.connect();
    const pending = Promise.withResolvers<readonly MicroInterface[]>();
    const started = Promise.withResolvers<void>();
    f.discovery.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    f.update([bluetooth]);
    await started.promise;
    for (let index = 0; index < 20; index++) f.update([usb]);
    const wired = f.until(() => f.controller.getSnapshot().transport === "USB");
    pending.resolve([bluetooth]);
    await wired;
    expect(f.open).toHaveBeenCalledTimes(2);
    await f.controller.disconnect();
  });

  it("ignores a discovery result that arrives after manual disconnect", async () => {
    const f = fixture([bluetooth]);
    await f.controller.connect();
    const pending = Promise.withResolvers<readonly MicroInterface[]>();
    const started = Promise.withResolvers<void>();
    f.discovery.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    f.update([usb]);
    await started.promise;
    const stopped = f.controller.disconnect();
    pending.resolve([usb]);
    await stopped;
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().enabled).toBe(false);
  });
  it("cancels a pending native open and closes its late handle", async () => {
    const f = fixture([bluetooth]);
    const originalOpen = f.open.getMockImplementation()!;
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    f.open.mockImplementationOnce(async (path) => {
      started.resolve();
      await gate.promise;
      return originalOpen(path);
    });
    const connecting = f.controller.connect();
    await started.promise;
    const stopped = f.controller.disconnect();
    gate.resolve();
    await Promise.all([connecting, stopped]);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: "disconnected", enabled: false });
    expect(f.handles[0]!.close).toHaveBeenCalledOnce();
    expect(f.unwatch).toHaveBeenCalledOnce();
  });

  it("retries transient access failures with a bounded backoff", async () => {
    vi.useFakeTimers();
    const f = fixture([bluetooth]);
    f.open.mockRejectedValue(new Error("Device is settling"));
    await f.controller.connect();
    await vi.advanceTimersByTimeAsync(4250);
    expect(f.open).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    await f.controller.disconnect();
  });

  it("manual disconnect cancels a scheduled retry", async () => {
    vi.useFakeTimers();
    const f = fixture([bluetooth]);
    f.open.mockRejectedValue(new Error("Device is settling"));
    await f.controller.connect();
    await f.controller.disconnect();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.unwatch).toHaveBeenCalledOnce();
  });

  it("keeps an active interface when enumeration order changes", async () => {
    const f = fixture([bluetooth]);
    await f.controller.connect();
    const started = Promise.withResolvers<void>();
    f.discovery.mockImplementationOnce(async () => {
      started.resolve();
      return [{ ...bluetooth, path: "other" }, bluetooth];
    });
    f.update([bluetooth]);
    await started.promise;
    await f.native.dispose();
    expect(f.open).toHaveBeenCalledOnce();
    await f.controller.disconnect();
  });
});
