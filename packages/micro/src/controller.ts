// @effect-diagnostics globalTimers:off -- The WebHID handshake deadline belongs to the browser connection lifecycle.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  MicroInput,
  MicroKeyBindingsSchema,
  MicroMappedActionSchema,
  type MicroAction,
  type MicroCommandKey,
  type MicroMappedAction,
} from "./input.ts";
import type {
  MicroHid,
  MicroHidDevice,
  MicroHidReportEvent,
  MicroHidConnectionEvent,
} from "./hid.ts";
import {
  encodeReports,
  lightingMessage,
  MICRO_PRODUCT_ID,
  MICRO_REPORT_ID,
  MICRO_SLOT_COUNT,
  MICRO_USAGE_PAGE,
  MICRO_VENDOR_ID,
  ReportDecoder,
  type MicroThreadStatus,
  type RpcMessage,
} from "./protocol.ts";

const ThreadAssignment = Schema.Struct({
  environmentId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
});
export type ThreadAssignment = typeof ThreadAssignment.Type;
const Config = Schema.Struct({
  slots: Schema.Array(Schema.NullOr(ThreadAssignment)).check(Schema.isMaxLength(MICRO_SLOT_COUNT)),
  microphone: Schema.NullOr(MicroMappedActionSchema),
  keyBindings: Schema.optional(MicroKeyBindingsSchema),
});
export type MicroConfig = typeof Config.Type;
const configCodec = Schema.fromJsonString(Config);
const decodeConfig = Schema.decodeUnknownOption(configCodec);
const Status = Schema.Struct({ version: Schema.optional(Schema.String) });
const decodeStatus = Schema.decodeUnknownOption(Status);
const STORAGE_KEY = "supacode.micro.v1";
const darkSlots = () =>
  Array.from({ length: MICRO_SLOT_COUNT }, (): MicroThreadStatus => "unavailable");

export type MicroSnapshot = {
  readonly phase:
    | "unsupported"
    | "disconnected"
    | "connecting"
    | "connected"
    | "disconnecting"
    | "error";
  readonly productName: string | null;
  readonly firmware: string | null;
  readonly error: string | null;
  readonly config: MicroConfig;
};

export class MicroController {
  private snapshot: MicroSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly actionListeners = new Set<(action: MicroAction) => void>();
  private readonly input = new MicroInput();
  private decoder = new ReportDecoder();
  private device: MicroHidDevice | null = null;
  private readonly hid: MicroHid | null;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private generation = 0;
  private writing: Promise<void> = Promise.resolve();
  private desired = darkSlots();
  private written = "";
  private flushing = false;
  private pendingStatus: {
    id: number;
    resolve: (message: RpcMessage) => void;
    reject: (error: Error) => void;
  } | null = null;
  private requestId = 0;

  constructor(hid: MicroHid | null, storage: Pick<Storage, "getItem" | "setItem"> | null = null) {
    this.hid = hid;
    this.storage = storage;
    let config: MicroConfig = {
      slots: Array.from({ length: MICRO_SLOT_COUNT }, () => null),
      microphone: null,
    };
    try {
      const decoded = decodeConfig(storage?.getItem(STORAGE_KEY));
      if (Option.isSome(decoded)) {
        config = {
          ...decoded.value,
          slots: Array.from({ length: MICRO_SLOT_COUNT }, (_, i) => decoded.value.slots[i] ?? null),
        };
      }
    } catch {}
    this.snapshot = {
      phase: hid ? "disconnected" : "unsupported",
      productName: null,
      firmware: null,
      error: null,
      config,
    };
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly subscribeActions = (listener: (action: MicroAction) => void) => {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  };

  assign(slot: number, assignment: ThreadAssignment | null): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MICRO_SLOT_COUNT) return;
    const slots = this.snapshot.config.slots.map((existing, index) =>
      index === slot ? assignment : existing,
    );
    this.saveConfig({ ...this.snapshot.config, slots });
  }

  setMicrophone(action: MicroMappedAction | null): void {
    this.saveConfig({ ...this.snapshot.config, microphone: action });
  }

  setKeyAction(key: MicroCommandKey, action: MicroMappedAction | null): void {
    this.saveConfig({
      ...this.snapshot.config,
      keyBindings: { ...this.snapshot.config.keyBindings, [key]: action },
    });
  }

  resetLayout(): void {
    this.saveConfig({ ...this.snapshot.config, keyBindings: {}, microphone: null });
  }

  private saveConfig(config: MicroConfig): void {
    this.storage?.setItem(STORAGE_KEY, Schema.encodeSync(configCodec)(config));
    this.publish({ config });
  }

  private publish(update: Partial<MicroSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }

  readonly connect = async (): Promise<void> => {
    if (
      !this.hid ||
      this.snapshot.phase === "connecting" ||
      this.snapshot.phase === "connected" ||
      this.snapshot.phase === "disconnecting"
    )
      return;
    const generation = ++this.generation;
    this.publish({ phase: "connecting", error: null });
    try {
      const devices = await this.hid.requestDevice({
        filters: [
          { vendorId: MICRO_VENDOR_ID, productId: MICRO_PRODUCT_ID, usagePage: MICRO_USAGE_PAGE },
        ],
      });
      const device = devices.find(
        (candidate) =>
          candidate.vendorId === MICRO_VENDOR_ID && candidate.productId === MICRO_PRODUCT_ID,
      );
      if (generation !== this.generation) return;
      if (!device) {
        this.publish({ phase: "disconnected" });
        return;
      }
      await device.open();
      if (generation !== this.generation) {
        await device.close();
        return;
      }
      this.device = device;
      this.decoder = new ReportDecoder();
      this.input.reset();
      this.written = "";
      device.addEventListener("inputreport", this.onReport);
      this.hid.addEventListener("disconnect", this.onDisconnect);
      const response = await this.checkStatus();
      const status = decodeStatus(response.result);
      if (generation !== this.generation) return;
      if (response.error !== undefined || Option.isNone(status))
        throw new Error("The Micro did not return a valid device status.");
      this.publish({
        phase: "connected",
        productName: device.productName,
        firmware: status.value.version ?? null,
        error: null,
      });
      this.flushLighting();
    } catch (error) {
      if (generation !== this.generation) return;
      await this.releaseDevice();
      if (generation !== this.generation) return;
      this.publish({
        phase: "error",
        error: error instanceof Error ? error.message : "Could not connect to the Micro.",
      });
    }
  };

  readonly disconnect = async (): Promise<void> => {
    if (this.snapshot.phase === "disconnecting") return;
    const generation = ++this.generation;
    this.publish({ phase: "disconnecting", error: null });
    const device = this.device;
    if (device?.opened) {
      try {
        await this.write(lightingMessage(darkSlots()), device);
      } catch {}
    }
    await this.releaseDevice();
    if (generation === this.generation)
      this.publish({
        phase: this.hid ? "disconnected" : "unsupported",
        productName: null,
        firmware: null,
      });
  };

  private async releaseDevice(): Promise<void> {
    const device = this.device;
    this.device = null;
    this.hid?.removeEventListener("disconnect", this.onDisconnect);
    device?.removeEventListener("inputreport", this.onReport);
    this.pendingStatus?.reject(new Error("The Micro disconnected."));
    this.pendingStatus = null;
    this.input.reset();
    this.written = "";
    if (device?.opened) {
      try {
        await device.close();
      } catch {}
    }
  }

  private readonly onDisconnect = (event: MicroHidConnectionEvent) => {
    if (event.device !== this.device) return;
    void this.disconnect();
  };

  private readonly onReport = (event: MicroHidReportEvent) => {
    if (event.device !== this.device) return;
    for (const message of this.decoder.read(event.reportId, event.data)) {
      if (message.id === this.pendingStatus?.id && this.pendingStatus) {
        this.pendingStatus.resolve(message);
        this.pendingStatus = null;
      }
      if (this.snapshot.phase !== "connected") continue;
      const action = this.input.read(
        message,
        this.snapshot.config.microphone,
        this.snapshot.config.keyBindings,
      );
      if (action) for (const listener of this.actionListeners) listener(action);
    }
  };

  private async checkStatus(): Promise<RpcMessage> {
    const device = this.device;
    if (!device) throw new Error("The Micro is not connected.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = (this.requestId + 1) % 1000;
    this.requestId = id;
    let pending: MicroController["pendingStatus"] = null;
    const response = new Promise<RpcMessage>((resolve, reject) => {
      pending = { id, resolve, reject };
      this.pendingStatus = pending;
      timer = setTimeout(
        () =>
          reject(new Error("The Micro did not respond. Release it in other apps, then reconnect.")),
        3000,
      );
    });
    try {
      const [, message] = await Promise.all([
        this.write({ method: "device.status", id }, device),
        response,
      ]);
      return message;
    } finally {
      clearTimeout(timer);
      if (this.pendingStatus === pending) this.pendingStatus = null;
    }
  }

  private write(message: object, device: MicroHidDevice): Promise<void> {
    const task = this.writing
      .catch(() => undefined)
      .then(async () => {
        if (device !== this.device || !device.opened) throw new Error("The Micro disconnected.");
        for (const report of encodeReports(message))
          await device.sendReport(MICRO_REPORT_ID, report);
      });
    this.writing = task;
    return task;
  }

  setStatuses(statuses: readonly MicroThreadStatus[]): void {
    this.desired = Array.from({ length: MICRO_SLOT_COUNT }, (_, i) => statuses[i] ?? "unavailable");
    this.flushLighting();
  }

  setSlotStatus(slot: number, status: MicroThreadStatus): void {
    if (slot < 0 || slot >= MICRO_SLOT_COUNT || this.desired[slot] === status) return;
    const statuses = [...this.desired];
    statuses[slot] = status;
    this.setStatuses(statuses);
  }

  private flushLighting(): void {
    if (this.flushing || this.snapshot.phase !== "connected" || !this.device) return;
    const device = this.device;
    this.flushing = true;
    const generation = this.generation;
    void (async () => {
      try {
        while (this.device === device && this.snapshot.phase === "connected") {
          const signature = this.desired.join(",");
          if (signature === this.written) break;
          await this.write(lightingMessage(this.desired), device);
          if (this.device !== device) break;
          this.written = signature;
        }
      } catch (error) {
        if (this.device !== device) return;
        await this.releaseDevice();
        if (generation !== this.generation) return;
        this.publish({
          phase: "error",
          error: error instanceof Error ? error.message : "Could not update the Micro's lights.",
        });
      } finally {
        this.flushing = false;
        if (this.device && this.device !== device) this.flushLighting();
      }
    })();
  }
}
