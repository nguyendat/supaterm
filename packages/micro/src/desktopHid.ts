import type {
  DesktopMicroBridge,
  DesktopMicroDevice,
  DesktopMicroEvent,
} from "@supacode/contracts/desktopMicro";
import type {
  MicroHid,
  MicroHidConnectionEvent,
  MicroHidDevice,
  MicroHidReportEvent,
} from "./hid.ts";
import { MICRO_PRODUCT_ID, MICRO_REPORT_ID, MICRO_VENDOR_ID } from "./protocol.ts";

class DesktopMicroHidDevice implements MicroHidDevice {
  private readonly bridge: DesktopMicroBridge;
  private readonly disconnected: () => void;
  readonly vendorId = MICRO_VENDOR_ID;
  readonly productId = MICRO_PRODUCT_ID;
  private info: DesktopMicroDevice | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<(event: MicroHidReportEvent) => void>();
  private disconnectedId: string | null = null;
  get productName() {
    return this.info?.productName ?? "Codex Micro";
  }
  get transport() {
    return this.info?.transport ?? null;
  }
  get opened() {
    return this.info !== null;
  }

  constructor(bridge: DesktopMicroBridge, disconnected: () => void) {
    this.bridge = bridge;
    this.disconnected = disconnected;
  }

  async open(): Promise<void> {
    this.unsubscribe = this.bridge.onEvent((event) => {
      if (!this.info) {
        if (event.type === "disconnected") this.disconnectedId = event.id;
      } else this.onEvent(event);
    });
    try {
      this.info = await this.bridge.open();
      if (this.disconnectedId === this.info.id)
        this.onEvent({ type: "disconnected", id: this.disconnectedId });
      if (!this.info) throw new Error("The Micro disconnected while connecting.");
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.disconnectedId = null;
      throw error;
    }
  }

  private onEvent(event: DesktopMicroEvent): void {
    if (event.id !== this.info?.id) return;
    if (event.type === "disconnected") {
      this.info = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.disconnected();
    } else if (event.data[0] === MICRO_REPORT_ID && event.data.length > 1) {
      const bytes = Uint8Array.from(event.data.subarray(1));
      const report = { device: this, reportId: MICRO_REPORT_ID, data: new DataView(bytes.buffer) };
      for (const listener of this.listeners) listener(report);
    }
  }

  async close(): Promise<void> {
    const info = this.info;
    this.info = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disconnectedId = null;
    if (info) await this.bridge.close(info.id);
  }

  async sendReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.info) throw new Error("The Micro is disconnected.");
    if (reportId !== MICRO_REPORT_ID) throw new Error("Invalid Micro report ID.");
    await this.bridge.write(this.info.id, data);
  }

  addEventListener(_type: "inputreport", listener: (event: MicroHidReportEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "inputreport", listener: (event: MicroHidReportEvent) => void): void {
    this.listeners.delete(listener);
  }
}

export class DesktopMicroHid implements MicroHid {
  private readonly bridge: DesktopMicroBridge;
  private readonly listeners = new Set<(event: MicroHidConnectionEvent) => void>();
  constructor(bridge: DesktopMicroBridge) {
    this.bridge = bridge;
  }
  async requestDevice(): Promise<MicroHidDevice[]> {
    const device = new DesktopMicroHidDevice(this.bridge, () => {
      for (const listener of this.listeners) listener({ device });
    });
    return [device];
  }
  addEventListener(_type: "disconnect", listener: (event: MicroHidConnectionEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: "disconnect",
    listener: (event: MicroHidConnectionEvent) => void,
  ): void {
    this.listeners.delete(listener);
  }
}
