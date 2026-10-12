export function hasMicroDeviceAccess(): boolean {
  return typeof navigator !== "undefined" && "hid" in navigator;
}

export interface MicroHidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
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
  requestDevice(options: {
    filters: readonly { vendorId: number; productId: number; usagePage: number }[];
  }): Promise<MicroHidDevice[]>;
  addEventListener(type: "disconnect", listener: (event: MicroHidConnectionEvent) => void): void;
  removeEventListener(type: "disconnect", listener: (event: MicroHidConnectionEvent) => void): void;
}
