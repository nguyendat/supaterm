import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@supacode/contracts";
import { MicroController } from "./controller.ts";
import type {
  MicroHid,
  MicroHidConnectionEvent,
  MicroHidDevice,
  MicroHidReportEvent,
} from "./hid.ts";
import {
  encodeReports,
  MICRO_PRODUCT_ID,
  MICRO_VENDOR_ID,
  ReportDecoder,
  type RpcMessage,
} from "./protocol.ts";

class FakeDevice implements MicroHidDevice {
  vendorId = MICRO_VENDOR_ID;
  productId = MICRO_PRODUCT_ID;
  productName = "Codex Micro";
  opened = false;
  respond = true;
  failLighting = false;
  messages: RpcMessage[] = [];
  listeners = new Set<(event: MicroHidReportEvent) => void>();
  decoder = new ReportDecoder();
  nextLighting: (() => void) | undefined;

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  addEventListener(_type: "inputreport", listener: (event: MicroHidReportEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "inputreport", listener: (event: MicroHidReportEvent) => void) {
    this.listeners.delete(listener);
  }
  emit(message: object) {
    for (const report of encodeReports(message))
      for (const listener of this.listeners)
        listener({ device: this, reportId: 6, data: new DataView(report.buffer) });
  }
  async sendReport(reportId: number, data: Uint8Array<ArrayBuffer>) {
    for (const message of this.decoder.read(reportId, new DataView(data.buffer))) {
      this.messages.push(message);
      if (message.method === "device.status" && this.respond)
        this.emit({ id: message.id, result: { version: "0.4.1" } });
      if (message.method === "v.oai.thstatus") {
        if (this.failLighting) throw new Error("Lighting write failed");
        this.nextLighting?.();
        this.nextLighting = undefined;
      }
    }
  }
  waitForLighting() {
    return new Promise<void>((resolve) => {
      this.nextLighting = resolve;
    });
  }
}

function fakeHid(device: FakeDevice) {
  const listeners = new Set<(event: MicroHidConnectionEvent) => void>();
  const hid: MicroHid = {
    requestDevice: vi.fn(async () => [device]),
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return { hid, listeners };
}

afterEach(() => vi.useRealTimers());

describe("Micro connection lifecycle", () => {
  it("keeps a new connection alive when an older device finishes failing", async () => {
    const oldDevice = new FakeDevice();
    oldDevice.failLighting = true;
    let finishClose!: () => void;
    let notifyClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      notifyClose = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    oldDevice.close = async () => {
      notifyClose();
      await closeGate;
      oldDevice.opened = false;
    };
    const { hid } = fakeHid(oldDevice);
    const micro = new MicroController(hid);
    await micro.connect();
    await closing;
    await micro.disconnect();
    const replacement = new FakeDevice();
    hid.requestDevice = async () => [replacement];
    const lighting = replacement.waitForLighting();
    await micro.connect();
    finishClose();
    await lighting;
    expect(micro.getSnapshot().phase).toBe("connected");
    const action = vi.fn();
    micro.subscribeActions(action);
    replacement.emit({ method: "v.oai.hid", params: { k: "ACT07", act: 1 } });
    expect(action).toHaveBeenCalledWith({ type: "approve" });
    await micro.disconnect();
  });
  it("requires a status round trip and sends the latest six-slot lighting state", async () => {
    const device = new FakeDevice();
    const { hid } = fakeHid(device);
    const micro = new MicroController(hid);
    micro.setSlotStatus(2, "input");
    const lighting = device.waitForLighting();
    await micro.connect();
    await lighting;
    expect(micro.getSnapshot()).toMatchObject({ phase: "connected", firmware: "0.4.1" });
    expect(
      device.messages.find((message) => message.method === "v.oai.thstatus")?.params,
    ).toContainEqual(expect.objectContaining({ id: 2, c: 0xffc26e }));
    const count = device.messages.length;
    micro.setSlotStatus(2, "input");
    await micro.disconnect();
    expect(device.messages).toHaveLength(count + 1);
    expect(device.opened).toBe(false);
    expect(device.listeners.size).toBe(0);
  });

  it("reports a timeout even when the OS accepts every write", async () => {
    vi.useFakeTimers();
    const device = new FakeDevice();
    device.respond = false;
    const { hid } = fakeHid(device);
    const micro = new MicroController(hid);
    const connection = micro.connect();
    await vi.advanceTimersByTimeAsync(3000);
    await connection;
    expect(micro.getSnapshot()).toMatchObject({ phase: "error" });
    expect(micro.getSnapshot().error).toContain("did not respond");
    expect(device.opened).toBe(false);
    expect(device.listeners.size).toBe(0);
  });

  it("does not acquire a device after the user cancels its chooser", async () => {
    const device = new FakeDevice();
    let choose!: (devices: MicroHidDevice[]) => void;
    const { hid } = fakeHid(device);
    hid.requestDevice = () =>
      new Promise((resolve) => {
        choose = resolve;
      });
    const micro = new MicroController(hid);
    const connection = micro.connect();
    await micro.disconnect();
    choose([device]);
    await connection;
    expect(micro.getSnapshot().phase).toBe("disconnected");
    expect(device.opened).toBe(false);
  });

  it("persists stable assignments independently of thread list order", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const micro = new MicroController(null, storage);
    micro.assign(4, {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread-9"),
    });
    micro.setMicrophone("focus");
    micro.setKeyAction("ACT07", "send");
    micro.setKeyAction("ACT08", null);
    const restored = new MicroController(null, storage);
    expect(restored.getSnapshot().config.slots[4]).toEqual({
      environmentId: "remote",
      threadId: "thread-9",
    });
    expect(restored.getSnapshot().config.microphone).toBe("focus");
    expect(restored.getSnapshot().config.keyBindings).toEqual({ ACT07: "send", ACT08: null });
    restored.resetLayout();
    expect(restored.getSnapshot().config.keyBindings).toEqual({});
    expect(restored.getSnapshot().config.microphone).toBeNull();
    expect(restored.getSnapshot().config.slots[4]?.threadId).toBe("thread-9");
    restored.assign(4, null);
    expect(restored.getSnapshot().config.slots[4]).toBeNull();
  });

  it("retains preferences saved before command key remapping", () => {
    const micro = new MicroController(null, {
      getItem: () =>
        JSON.stringify({
          slots: [{ environmentId: "remote", threadId: "saved" }],
          microphone: "focus",
        }),
      setItem: () => undefined,
    });
    expect(micro.getSnapshot().config.slots[0]?.threadId).toBe("saved");
    expect(micro.getSnapshot().config.microphone).toBe("focus");
    expect(micro.getSnapshot().config.keyBindings).toBeUndefined();
  });
});
