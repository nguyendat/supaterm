export interface MicroHidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly transport?: "USB" | "Bluetooth" | null;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void>;
  addEventListener(type: "inputreport", listener: (event: MicroHidReportEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (event: MicroHidReportEvent) => void): void;
}

export interface MicroHidReportEvent {
  readonly device: MicroHidDevice;
  readonly reportId: number;
  readonly data: DataView;
}

export interface MicroHidConnectionEvent {
  readonly device: MicroHidDevice;
}

export interface MicroHid {
  subscribeTopology?(listener: () => void): () => void;
  stop?(): Promise<void>;
  requestDevice(options: {
    filters: readonly { vendorId: number; productId: number; usagePage: number }[];
  }): Promise<MicroHidDevice[]>;
  addEventListener(type: "disconnect", listener: (event: MicroHidConnectionEvent) => void): void;
  removeEventListener(type: "disconnect", listener: (event: MicroHidConnectionEvent) => void): void;
}

export class MicroUnavailableError extends Error {
  constructor() {
    super("No Micro found. Connect USB or pair the Micro in your system’s Bluetooth settings.");
  }
}
