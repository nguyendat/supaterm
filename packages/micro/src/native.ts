import type { Device, HIDAsync } from "node-hid";
import type { DesktopMicroDevice, DesktopMicroEvent } from "@supacode/contracts/desktopMicro";
import {
  MICRO_PRODUCT_ID,
  MICRO_REPORT_ID,
  MICRO_USAGE_PAGE,
  MICRO_VENDOR_ID,
} from "./protocol.ts";
import type { MicroInterface, MicroTopology } from "./topology.ts";
import { MicroUnavailableError } from "./hid.ts";

type NativeHandle = Pick<HIDAsync, "close" | "write"> & {
  on(type: "data" | "error", listener: (data: Uint8Array) => void): unknown;
  off(type: "data" | "error", listener: (data: Uint8Array) => void): unknown;
};
export type NativeHid = {
  devicesAsync(vendorId: number, productId: number): Promise<Device[]>;
  HIDAsync: { open(path: string, options: { nonExclusive: boolean }): Promise<NativeHandle> };
};

const transportOf = (device: Device | MicroInterface) =>
  "transport" in device ? device.transport : (device.release & 3) === 0 ? "USB" : "Bluetooth";

export class MicroAccessError extends Error {
  constructor(cause: unknown) {
    super("Could not open the Micro device.", { cause });
  }
}

export class NativeMicro {
  private readonly emit: (event: DesktopMicroEvent) => void;
  private readonly loadHid: () => Promise<NativeHid>;
  private readonly topology: MicroTopology | undefined;
  private unwatch: (() => void) | null = null;
  private watchVersion = 0;
  private topologyDirty = false;
  private topologyScan: Promise<void> | null = null;
  private generation = 0;
  private pending: Promise<DesktopMicroDevice> | null = null;
  private closing: Promise<void> = Promise.resolve();
  private connection: {
    id: string;
    path: string;
    handle: NativeHandle;
    onData: (data: Uint8Array) => void;
    onError: () => void;
  } | null = null;

  constructor(
    emit: (event: DesktopMicroEvent) => void,
    loadHid: () => Promise<NativeHid> = () => import("node-hid"),
    topology?: MicroTopology,
  ) {
    this.emit = emit;
    this.loadHid = loadHid;
    this.topology = topology;
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
    if (generation !== this.generation) throw new Error("Micro connection cancelled.");
    if (this.topology && !this.unwatch) {
      const version = ++this.watchVersion;
      this.unwatch = this.topology.watch(() => {
        if (version === this.watchVersion) void this.reconcileTopology();
      });
    }
    const hid = await this.loadHid();
    const devices = this.topology
      ? await this.topology.find()
      : await hid.devicesAsync(MICRO_VENDOR_ID, MICRO_PRODUCT_ID);
    const device = this.selectDevice(devices);
    if (!device?.path) throw new MicroUnavailableError();
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
      void this.close(id)
        .finally(() => this.emit({ type: "disconnected", id }))
        .catch(() => {});
    };
    this.connection = { id, path: device.path, handle, onData, onError };
    handle.on("error", onError);
    handle.on("data", onData);
    return {
      id,
      productName: device.product ?? "Codex Micro",
      transport: transportOf(device),
    };
  }

  private selectDevice(devices: readonly (Device | MicroInterface)[]) {
    const candidates = devices.filter(
      (device) =>
        device.vendorId === MICRO_VENDOR_ID &&
        device.productId === MICRO_PRODUCT_ID &&
        device.usagePage === MICRO_USAGE_PAGE &&
        device.path,
    );
    const current = candidates.find((candidate) => candidate.path === this.connection?.path);
    if (current && transportOf(current) === "USB") return current;
    return (
      candidates.find((candidate) => transportOf(candidate) === "USB") ?? current ?? candidates[0]
    );
  }

  private reconcileTopology(): Promise<void> {
    this.topologyDirty = true;
    if (this.topologyScan) return this.topologyScan;
    const version = this.watchVersion;
    const scan = (async () => {
      while (this.topologyDirty && this.unwatch && version === this.watchVersion) {
        this.topologyDirty = false;
        await this.pending?.catch(() => {});
        const selected = this.selectDevice(await this.topology!.find());
        if (version !== this.watchVersion) return;
        const connection = this.connection;
        if (connection && connection.path !== selected?.path) {
          await this.close(connection.id).catch(() => {});
          if (version !== this.watchVersion) return;
          this.emit({ type: "disconnected", id: connection.id });
        }
        if (!this.connection) this.emit({ type: "topology" });
      }
    })()
      .catch(() => {
        if (version === this.watchVersion && !this.connection) this.emit({ type: "topology" });
      })
      .finally(() => {
        if (this.topologyScan === scan) this.topologyScan = null;
      });
    this.topologyScan = scan;
    return scan;
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
    ++this.watchVersion;
    this.topologyDirty = false;
    this.unwatch?.();
    this.unwatch = null;
    ++this.generation;
    if (this.connection) await this.close(this.connection.id).catch(() => {});
    await this.pending?.catch(() => {});
    await this.closing;
    await this.topologyScan;
  }
}
