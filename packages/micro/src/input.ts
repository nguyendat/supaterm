import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { RpcMessage } from "./protocol.ts";

export const MICRO_ACTIONS = {
  fast: "Fast mode",
  approve: "Approve",
  reject: "Reject",
  fork: "Fork",
  send: "Send",
  focus: "Focus composer",
  effortMenu: "Reasoning effort menu",
} as const;
export type MicroMappedAction = keyof typeof MICRO_ACTIONS;
export type MicroAction =
  | { type: MicroMappedAction }
  | { type: "thread"; slot: number }
  | { type: "effort"; direction: 1 | -1 }
  | { type: "joystick"; direction: "up" | "right" | "down" | "left" };

export const MicroMappedActionSchema = Schema.Literals([
  "fast",
  "approve",
  "reject",
  "fork",
  "send",
  "focus",
  "effortMenu",
]);
const KeyAction = Schema.optional(Schema.NullOr(MicroMappedActionSchema));
export const MicroKeyBindingsSchema = Schema.Struct({
  ACT06: KeyAction,
  ACT07: KeyAction,
  ACT08: KeyAction,
  ACT09: KeyAction,
  ACT12: KeyAction,
  ENC_CLK: KeyAction,
});
export type MicroKeyBindings = typeof MicroKeyBindingsSchema.Type;
export type MicroCommandKey = keyof MicroKeyBindings;
export const DEFAULT_MICRO_KEY_BINDINGS = {
  ACT06: "fast",
  ACT07: "approve",
  ACT08: "reject",
  ACT09: "fork",
  ACT12: "send",
  ENC_CLK: "effortMenu",
} as const satisfies Readonly<Record<MicroCommandKey, MicroMappedAction>>;

export function resolveMicroKeyAction(key: MicroCommandKey, bindings: MicroKeyBindings = {}) {
  return Object.hasOwn(bindings, key) ? (bindings[key] ?? null) : DEFAULT_MICRO_KEY_BINDINGS[key];
}

function isCommandKey(key: string): key is MicroCommandKey {
  return Object.hasOwn(DEFAULT_MICRO_KEY_BINDINGS, key);
}

const KeyEvent = Schema.Struct({ k: Schema.String, act: Schema.Int });
const RadialEvent = Schema.Struct({
  a: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  d: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
const decodeKey = Schema.decodeUnknownOption(KeyEvent);
const decodeRadial = Schema.decodeUnknownOption(RadialEvent);

export class MicroInput {
  private down = new Set<string>();
  private joystickActive = false;

  reset(): void {
    this.down.clear();
    this.joystickActive = false;
  }

  read(
    message: RpcMessage,
    microphone: MicroMappedAction | null,
    bindings: MicroKeyBindings = {},
  ): MicroAction | null {
    const method = message.method ?? message.m;
    const params = message.params ?? message.p;
    if (method === "v.oai.rad") {
      const decoded = decodeRadial(params);
      if (Option.isNone(decoded)) return null;
      const { a, d } = decoded.value;
      if (d < 0.2) this.joystickActive = false;
      if (d < 0.6 || this.joystickActive) return null;
      this.joystickActive = true;
      const direction = (["right", "down", "left", "up"] as const)[Math.round(a * 4) % 4];
      return direction ? { type: "joystick", direction } : null;
    }
    if (method !== "v.oai.hid") return null;
    const decoded = decodeKey(params);
    if (Option.isNone(decoded)) return null;
    const { k, act } = decoded.value;
    if (k === "ENC_CW" || k === "ENC_CC") {
      return { type: "effort", direction: k === "ENC_CW" ? 1 : -1 };
    }
    if (act === 0) {
      this.down.delete(k);
      return null;
    }
    if (act !== 1 || this.down.has(k)) return null;
    const microphoneDown = this.down.has("ACT10") || this.down.has("ACT11");
    this.down.add(k);
    if (k === "ACT10" || k === "ACT11") {
      return microphone && !microphoneDown ? { type: microphone } : null;
    }
    const slot = /^AG0([0-5])$/.exec(k)?.[1];
    if (slot !== undefined) return { type: "thread", slot: Number(slot) };
    const action = isCommandKey(k) ? resolveMicroKeyAction(k, bindings) : null;
    return action ? { type: action } : null;
  }
}
