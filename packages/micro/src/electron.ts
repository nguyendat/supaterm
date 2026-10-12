import type { BrowserWindow, Event, SelectHidDeviceDetails } from "electron";
import { MICRO_PRODUCT_ID, MICRO_VENDOR_ID } from "./protocol.ts";

export function installMicroDeviceSelection(window: BrowserWindow, applicationUrl: string): void {
  const expected = new URL(applicationUrl);
  const session = window.webContents.session;
  const select = (
    event: Event,
    details: SelectHidDeviceDetails,
    callback: (deviceId: string) => void,
  ) => {
    const frame = details.frame;
    const requested = frame ? new URL(frame.url) : null;
    if (
      !frame ||
      frame !== window.webContents.mainFrame ||
      requested?.protocol !== expected.protocol ||
      requested.host !== expected.host
    )
      return;
    const device = details.deviceList.find(
      (candidate) =>
        candidate.vendorId === MICRO_VENDOR_ID && candidate.productId === MICRO_PRODUCT_ID,
    );
    event.preventDefault();
    callback(device?.deviceId ?? "");
  };
  session.on("select-hid-device", select);
  window.once("closed", () => session.off("select-hid-device", select));
}
