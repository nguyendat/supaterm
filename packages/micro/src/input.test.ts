import { describe, expect, it } from "vite-plus/test";
import { MicroInput } from "./input.ts";

const key = (k: string, act = 1) => ({ method: "v.oai.hid", params: { k, act } });

describe("Micro controls", () => {
  it.each([
    ["ACT06", "fast"],
    ["ACT07", "approve"],
    ["ACT08", "reject"],
    ["ACT09", "fork"],
    ["ACT12", "send"],
  ])("maps %s to %s and suppresses held-key duplicates", (id, action) => {
    const input = new MicroInput();
    expect(input.read(key(id), null)).toEqual({ type: action });
    expect(input.read(key(id), null)).toBeNull();
    expect(input.read(key(id, 0), null)).toBeNull();
    expect(input.read(key(id), null)).toEqual({ type: action });
  });

  it("treats the wide microphone key's two switches as one press", () => {
    const input = new MicroInput();
    expect(input.read(key("ACT10"), "send")).toEqual({ type: "send" });
    expect(input.read(key("ACT11"), "send")).toBeNull();
    input.read(key("ACT10", 0), "send");
    expect(input.read(key("ACT10"), "send")).toBeNull();
    input.read(key("ACT10", 0), "send");
    input.read(key("ACT11", 0), "send");
    expect(input.read(key("ACT11"), "send")).toEqual({ type: "send" });
  });

  it("remaps command presses and allows a key to be unassigned", () => {
    const input = new MicroInput();
    expect(input.read(key("ACT07"), null, { ACT07: "focus" })).toEqual({ type: "focus" });
    input.read(key("ACT07", 0), null);
    expect(input.read(key("ACT07"), null, { ACT07: null })).toBeNull();
    expect(input.read(key("ENC_CLK"), null, { ENC_CLK: "send" })).toEqual({ type: "send" });
    expect(input.read(key("ACT06"), null, { ACT07: null })).toEqual({ type: "fast" });
  });

  it("accepts dial detents with non-key act values", () => {
    const input = new MicroInput();
    expect(input.read(key("ENC_CW", 2), null)).toEqual({ type: "effort", direction: 1 });
    expect(input.read(key("ENC_CC", 0), null)).toEqual({ type: "effort", direction: -1 });
    expect(input.read(key("AG05"), null)).toEqual({ type: "thread", slot: 5 });
  });

  it("fires a joystick action once per deflection and rearms at the center", () => {
    const input = new MicroInput();
    const radial = (a: number, d: number) => ({ method: "v.oai.rad", params: { a, d } });
    expect(input.read(radial(0.25, 0.8), null)).toEqual({ type: "joystick", direction: "down" });
    expect(input.read(radial(0.75, 0.9), null)).toBeNull();
    expect(input.read(radial(0, 0), null)).toBeNull();
    expect(input.read(radial(0.75, 0.8), null)).toEqual({ type: "joystick", direction: "up" });
  });
});
