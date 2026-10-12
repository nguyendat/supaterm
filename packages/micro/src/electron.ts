import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import * as Schema from "effect/Schema";
import { DesktopMicroWriteSchema } from "@supacode/contracts/desktopMicro";
import { DESKTOP_MICRO_CHANNELS } from "./channels.ts";
import { MicroAccessError, NativeMicro } from "./native.ts";
import { hasInputMonitoringPermission } from "./permissions.ts";
import { macMicroHid, macMicroTopology } from "./topology.ts";
import { MicroUnavailableError } from "./hid.ts";

const decodeId = Schema.decodeUnknownSync(Schema.String);
const decodeWrite = Schema.decodeUnknownSync(DesktopMicroWriteSchema);

export function installMicro(
  window: BrowserWindow,
  applicationUrl: string,
  platform: string,
  nativeDirectory: string,
): void {
  const expected = new URL(applicationUrl);
  const contents = window.webContents;
  const micro = new NativeMicro(
    (event) => {
      if (!contents.isDestroyed()) contents.send(DESKTOP_MICRO_CHANNELS.event, event);
    },
    platform === "darwin" ? async () => macMicroHid(`${nativeDirectory}/micro-hid`) : undefined,
    platform === "darwin"
      ? macMicroTopology(`${nativeDirectory}/micro-hid/topology.node`)
      : undefined,
  );
  const authorize = (event: IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    const requested = frame ? new URL(frame.url) : null;
    if (
      !frame ||
      frame !== contents.mainFrame ||
      requested?.protocol !== expected.protocol ||
      requested.host !== expected.host
    )
      throw new Error("Micro access is only available to the desktop app.");
  };
  contents.ipc.handle(DESKTOP_MICRO_CHANNELS.open, async (event) => {
    authorize(event);
    try {
      return await micro.open();
    } catch (error) {
      if (error instanceof MicroUnavailableError) return null;
      if (
        error instanceof MicroAccessError &&
        platform === "darwin" &&
        !(await hasInputMonitoringPermission())
      )
        throw new Error(
          "Allow Supacode in System Settings → Privacy & Security → Input Monitoring, then restart Supacode and connect again.",
          { cause: error },
        );
      throw error;
    }
  });
  contents.ipc.handle(DESKTOP_MICRO_CHANNELS.close, (event, raw: unknown) => {
    authorize(event);
    return micro.close(decodeId(raw));
  });
  contents.ipc.handle(DESKTOP_MICRO_CHANNELS.write, (event, raw: unknown) => {
    authorize(event);
    const { id, data } = decodeWrite(raw);
    return micro.write(id, data);
  });
  contents.ipc.handle(DESKTOP_MICRO_CHANNELS.stop, (event) => {
    authorize(event);
    return micro.dispose();
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) void micro.dispose();
  });
  contents.on("render-process-gone", () => {
    void micro.dispose();
  });
  window.once("closed", () => {
    void micro.dispose();
  });
}
