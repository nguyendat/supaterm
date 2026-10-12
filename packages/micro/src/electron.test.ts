import * as NodeEvents from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { DESKTOP_MICRO_CHANNELS } from "@supacode/contracts/desktopMicro";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { installMicro } from "./electron.ts";
import { MicroAccessError, NativeMicro } from "./native.ts";
import { hasInputMonitoringPermission } from "./permissions.ts";

vi.mock("./permissions.ts", () => ({ hasInputMonitoringPermission: vi.fn(async () => false) }));

afterEach(() => vi.restoreAllMocks());

function fixture(platform = "linux") {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, raw?: unknown) => unknown>();
  const mainFrame = { url: "supacode://app/settings/micro" };
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    mainFrame,
    isDestroyed: () => false,
    send: vi.fn(),
    ipc: {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, raw?: unknown) => unknown) =>
        handlers.set(channel, handler),
    },
  });
  const window = Object.assign(new NodeEvents.EventEmitter(), { webContents: contents });
  installMicro(window as unknown as BrowserWindow, "supacode://app/", platform);
  const invoke = (channel: string, frame = mainFrame, raw?: unknown) =>
    handlers.get(channel)!({ senderFrame: frame } as unknown as IpcMainInvokeEvent, raw);
  return { invoke, mainFrame };
}

describe("desktop Micro IPC authorization", () => {
  it("accepts the app main frame", async () => {
    const open = vi
      .spyOn(NativeMicro.prototype, "open")
      .mockResolvedValue({ id: "1", productName: "Micro", transport: "Bluetooth" });
    const f = fixture();
    await expect(f.invoke(DESKTOP_MICRO_CHANNELS.open)).resolves.toMatchObject({
      transport: "Bluetooth",
    });
    expect(open).toHaveBeenCalledOnce();
  });

  it("rejects child frames and a main frame navigated outside the app", async () => {
    const open = vi.spyOn(NativeMicro.prototype, "open");
    const f = fixture();
    await expect(f.invoke(DESKTOP_MICRO_CHANNELS.open, { url: f.mainFrame.url })).rejects.toThrow(
      "desktop app",
    );
    f.mainFrame.url = "https://example.com";
    await expect(f.invoke(DESKTOP_MICRO_CHANNELS.open)).rejects.toThrow("desktop app");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects malformed reports before they reach the native handle", () => {
    const write = vi.spyOn(NativeMicro.prototype, "write");
    const f = fixture();
    expect(() =>
      f.invoke(DESKTOP_MICRO_CHANNELS.write, f.mainFrame, { id: "1", data: [6, 2] }),
    ).toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("explains missing macOS Input Monitoring when opening the device fails", async () => {
    vi.spyOn(NativeMicro.prototype, "open").mockRejectedValue(
      new MicroAccessError(new Error("not permitted")),
    );
    const f = fixture("darwin");
    await expect(f.invoke(DESKTOP_MICRO_CHANNELS.open)).rejects.toThrow("Input Monitoring");
    expect(hasInputMonitoringPermission).toHaveBeenCalled();
  });

  it("preserves device discovery errors instead of reporting a permission failure", async () => {
    vi.spyOn(NativeMicro.prototype, "open").mockRejectedValue(new Error("No Micro found"));
    const f = fixture("darwin");
    await expect(f.invoke(DESKTOP_MICRO_CHANNELS.open)).rejects.toThrow("No Micro found");
  });
});
