import type { ProviderOptionDescriptor } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveMicroComposerChange } from "./composer.ts";

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
    expect(resolveMicroComposerChange("codex", descriptors, { type: "fast" })).toEqual({
      prompt: null,
      options: [{ id: "serviceTier", value: "priority" }],
    });
    expect(
      resolveMicroComposerChange("codex", [{ ...descriptors[0]!, currentValue: "priority" }], {
        type: "fast",
      }),
    ).toEqual({ prompt: null, options: [{ id: "serviceTier", value: "default" }] });
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
      resolveMicroComposerChange("codex", descriptors, { type: "effort", direction: -1 }),
    ).toEqual({ prompt: null, options: [{ id: "effort", value: "low" }] });
    expect(
      resolveMicroComposerChange("codex", [{ ...descriptors[0]!, currentValue: "xhigh" }], {
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
    expect(resolveMicroComposerChange("opencode", descriptors, { type: "fast" })).toBeNull();
    expect(
      resolveMicroComposerChange("opencode", descriptors, { type: "effort", direction: 1 }),
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
      resolveMicroComposerChange(
        "claudeAgent",
        descriptors,
        { type: "effort", direction: -1 },
        prompt,
      ),
    ).toEqual({ prompt: "Review this code", options: [{ id: "effort", value: "max" }] });
    expect(
      resolveMicroComposerChange(
        "claudeAgent",
        descriptors,
        { type: "effort", direction: 1 },
        prompt,
      ),
    ).toBeNull();
    expect(
      resolveMicroComposerChange(
        "claudeAgent",
        descriptors,
        { type: "effort", direction: -1 },
        "Please ultrathink about this code",
      ),
    ).toBeNull();
  });

  it("transitions prompt effort independently of descriptor order", () => {
    const descriptors: ProviderOptionDescriptor[] = [
      {
        id: "contextWindow",
        type: "select",
        label: "Context",
        currentValue: "long",
        options: [{ id: "long", label: "Long" }],
      },
      {
        id: "effort",
        type: "select",
        label: "Effort",
        currentValue: "max",
        promptInjectedValues: ["ultrathink"],
        options: [
          { id: "max", label: "Max" },
          { id: "ultrathink", label: "Ultrathink" },
        ],
      },
    ];
    expect(
      resolveMicroComposerChange(
        "claudeAgent",
        descriptors,
        { type: "effort", direction: 1 },
        "Review this code",
      ),
    ).toEqual({ prompt: "Ultrathink:\nReview this code", options: null });
    expect(
      resolveMicroComposerChange(
        "claudeAgent",
        descriptors,
        { type: "effort", direction: -1 },
        "Ultrathink:\nReview this code",
      ),
    ).toEqual({
      prompt: "Review this code",
      options: [
        { id: "contextWindow", value: "long" },
        { id: "effort", value: "max" },
      ],
    });
  });

  it("toggles boolean speed controls while preserving unrelated selections", () => {
    const descriptors: ProviderOptionDescriptor[] = [
      { id: "fastMode", type: "boolean", label: "Fast", currentValue: false },
      {
        id: "effort",
        type: "select",
        label: "Effort",
        currentValue: "high",
        options: [{ id: "high", label: "High" }],
      },
    ];
    expect(resolveMicroComposerChange("claudeAgent", descriptors, { type: "fast" })).toEqual({
      prompt: null,
      options: [
        { id: "fastMode", value: true },
        { id: "effort", value: "high" },
      ],
    });
    expect(descriptors[0]?.currentValue).toBe(false);
  });
});
