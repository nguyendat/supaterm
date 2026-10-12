import type { Device, HIDAsync } from "node-hid";
import type { DesktopMicroDevice, DesktopMicroEvent } from "@supacode/contracts/desktopMicro";
import {
  MICRO_PRODUCT_ID,
  MICRO_REPORT_ID,
  MICRO_USAGE_PAGE,
  MICRO_VENDOR_ID,
} from "./protocol.ts";

type NativeHandle = Pick<HIDAsync, "close" | "write"> & {
  on(type: "data" | "error", listener: (data: Uint8Array) => void): unknown;
  off(type: "data" | "error", listener: (data: Uint8Array) => void): unknown;
};
type NativeHid = {
  devicesAsync(vendorId: number, productId: number): Promise<Device[]>;
  HIDAsync: { open(path: string, options: { nonExclusive: boolean }): Promise<NativeHandle> };
};

export class MicroAccessError extends Error {
  constructor(cause: unknown) {
    super("Could not open the Micro device.", { cause });
  }
}

export class NativeMicro {
  private readonly emit: (event: DesktopMicroEvent) => void;
  private readonly loadHid: () => Promise<NativeHid>;
  private generation = 0;
  private pending: Promise<DesktopMicroDevice> | null = null;
  private closing: Promise<void> = Promise.resolve();
  private connection: {
    id: string;
    handle: NativeHandle;
    onData: (data: Uint8Array) => void;
    onError: () => void;
  } | null = null;

  constructor(
    emit: (event: DesktopMicroEvent) => void,
    loadHid: () => Promise<NativeHid> = () => import("node-hid"),
  ) {
    this.emit = emit;
    this.loadHid = loadHid;
  }

  open(): Promise<DesktopMicroDevice> {
    if (this.pending || this.connection)
      return Promise.reject(new Error("The Micro is already connected or connecting."));
    const pending = this.openDevice(++this.generation).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  private async openDevice(generation: number): Promise<DesktopMicroDevice> {
    await this.closing;
    const hid = await this.loadHid();
    const devices = await hid.devicesAsync(MICRO_VENDOR_ID, MICRO_PRODUCT_ID);
    const candidates = devices.filter(
      (device) =>
        device.vendorId === MICRO_VENDOR_ID &&
        device.productId === MICRO_PRODUCT_ID &&
        device.usagePage === MICRO_USAGE_PAGE &&
        device.path,
    );
    const device = candidates.find((candidate) => (candidate.release & 3) === 0) ?? candidates[0];
    if (!device?.path)
      throw new Error(
        "No Micro found. Connect USB or pair the Micro in your system’s Bluetooth settings.",
      );
    if (generation !== this.generation) throw new Error("Micro connection cancelled.");
    const handle = await hid.HIDAsync.open(device.path, { nonExclusive: true }).catch((cause) => {
      throw new MicroAccessError(cause);
    });
    if (generation !== this.generation) {
      await handle.close();
      throw new Error("Micro connection cancelled.");
    }
    const id = String(generation);
    const onData = (data: Uint8Array) => {
      if (this.connection?.id === id && data[0] === MICRO_REPORT_ID && data.length <= 64)
        this.emit({ type: "report", id, data: Uint8Array.from(data) });
    };
    const onError = () => {
      if (this.connection?.id !== id) return;
      this.emit({ type: "disconnected", id });
      void this.close(id).catch(() => {});
    };
    this.connection = { id, handle, onData, onError };
    handle.on("error", onError);
    handle.on("data", onData);
    return {
      id,
      productName: device.product ?? "Codex Micro",
      transport: (device.release & 3) === 0 ? "USB" : "Bluetooth",
    };
  }

  async write(id: string, data: Uint8Array): Promise<void> {
    const connection = this.connection;
    if (connection?.id !== id) throw new Error("The Micro is disconnected.");
    if (data.length !== 63) throw new Error("Invalid Micro report length.");
    const written = await connection.handle.write([MICRO_REPORT_ID, ...data]);
    if (written !== 64) throw new Error("The Micro did not accept the complete report.");
  }

  close(id: string): Promise<void> {
    const connection = this.connection;
    if (connection?.id !== id) return Promise.resolve();
    this.connection = null;
    connection.handle.off("data", connection.onData);
    const closing = connection.handle.close().finally(() => {
      connection.handle.off("error", connection.onError);
    });
    this.closing = closing.catch(() => {});
    return closing;
  }

  async dispose(): Promise<void> {
    ++this.generation;
    if (this.connection) await this.close(this.connection.id).catch(() => {});
    await this.pending?.catch(() => {});
    await this.closing;
  }
}
