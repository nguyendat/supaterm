import * as Schema from "effect/Schema";

export const DESKTOP_MICRO_CHANNELS = {
  open: "micro:open",
  close: "micro:close",
  write: "micro:write",
  event: "micro:event",
} as const;

export interface DesktopMicroDevice {
  readonly id: string;
  readonly productName: string;
  readonly transport: "USB" | "Bluetooth";
}

export type DesktopMicroEvent =
  | { readonly type: "report"; readonly id: string; readonly data: Uint8Array }
  | { readonly type: "disconnected"; readonly id: string };

export const DesktopMicroWriteSchema = Schema.Struct({
  id: Schema.String,
  data: Schema.Uint8Array,
});

export interface DesktopMicroBridge {
  open(): Promise<DesktopMicroDevice>;
  close(id: string): Promise<void>;
  write(id: string, data: Uint8Array): Promise<void>;
  onEvent(listener: (event: DesktopMicroEvent) => void): () => void;
}
