import type { ProviderOptionDescriptor } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveMicroOptionChange } from "./composer.ts";

describe("Micro composer controls", () => {
  it("uses the provider's speed tier instead of changing reasoning effort", () => {
    const descriptors: Extract<ProviderOptionDescriptor, { type: "select" }>[] = [
      {
        id: "serviceTier",
        type: "select",
        label: "Speed",
        currentValue: "default",
        options: [
          { id: "default", label: "Normal" },
          { id: "priority", label: "Fast" },
        ],
      },
    ];
    expect(resolveMicroOptionChange("codex", descriptors, { type: "fast" })).toEqual({
      id: "serviceTier",
      value: "priority",
    });
    expect(
      resolveMicroOptionChange("codex", [{ ...descriptors[0]!, currentValue: "priority" }], {
        type: "fast",
      }),
    ).toEqual({ id: "serviceTier", value: "default" });
  });

  it("steps only supported effort levels without wrapping at the boundary", () => {
    const descriptors: Extract<ProviderOptionDescriptor, { type: "select" }>[] = [
      {
        id: "effort",
        type: "select",
        label: "Effort",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" },
        ],
      },
    ];
    expect(
      resolveMicroOptionChange("codex", descriptors, { type: "effort", direction: -1 }),
    ).toEqual({ id: "effort", value: "low" });
    expect(
      resolveMicroOptionChange("codex", [{ ...descriptors[0]!, currentValue: "xhigh" }], {
        type: "effort",
        direction: 1,
      }),
    ).toBeNull();
  });

  it("leaves providers without speed or effort controls unchanged", () => {
    const descriptors: ProviderOptionDescriptor[] = [
      {
        id: "contextWindow",
        label: "Context",
        type: "select",
        options: [{ id: "long", label: "Long" }],
        currentValue: "long",
      },
    ];
    expect(resolveMicroOptionChange("opencode", descriptors, { type: "fast" })).toBeNull();
    expect(
      resolveMicroOptionChange("opencode", descriptors, { type: "effort", direction: 1 }),
    ).toBeNull();
  });

  it("steps down from prompt-controlled effort without skipping the persisted level", () => {
    const descriptors: Extract<ProviderOptionDescriptor, { type: "select" }>[] = [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        currentValue: "max",
        promptInjectedValues: ["ultrathink"],
        options: [
          { id: "high", label: "High" },
          { id: "max", label: "Max" },
          { id: "ultrathink", label: "Ultrathink" },
        ],
      },
    ];
    const prompt = "Ultrathink:\nReview this code";
    expect(
      resolveMicroOptionChange(
        "claudeAgent",
        descriptors,
        { type: "effort", direction: -1 },
        prompt,
      ),
    ).toEqual({ id: "effort", value: "max" });
    expect(
      resolveMicroOptionChange(
        "claudeAgent",
        descriptors,
        { type: "effort", direction: 1 },
        prompt,
      ),
    ).toBeNull();
    expect(
      resolveMicroOptionChange(
        "claudeAgent",
        descriptors,
        { type: "effort", direction: -1 },
        "Please ultrathink about this code",
      ),
    ).toBeNull();
  });
});
