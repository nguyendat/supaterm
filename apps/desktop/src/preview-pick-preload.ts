import { ipcRenderer } from "electron";

import { PASSKEY_BRIDGE_ARGUMENT } from "./preview/GuestProtocol.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import "./preview/PickPreload.ts";

if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
  installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
}
