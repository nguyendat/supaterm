import * as Schema from "effect/Schema";

export interface DesktopMicroDevice {
  readonly id: string;
  readonly productName: string;
  readonly transport: "USB" | "Bluetooth";
}

export type DesktopMicroEvent =
  | { readonly type: "topology" }
  | { readonly type: "report"; readonly id: string; readonly data: Uint8Array }
  | { readonly type: "disconnected"; readonly id: string };

export const DesktopMicroWriteSchema = Schema.Struct({
  id: Schema.String,
  data: Schema.Uint8Array,
});

export interface DesktopMicroBridge {
  readonly supportsTopology?: boolean;
  open(): Promise<DesktopMicroDevice | null>;
  close(id: string): Promise<void>;
  write(id: string, data: Uint8Array): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: DesktopMicroEvent) => void): () => void;
}
