import type { ProviderOptionDescriptor } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveProviderPromptEffortState, resolveProviderSelectChange } from "./providerTraits.ts";

const descriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  currentValue: "max",
  options: [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
} satisfies ProviderOptionDescriptor;

describe("Prompt-controlled provider traits", () => {
  it("uses prompt state as the effective effort while preserving the saved option", () => {
    expect(resolveProviderPromptEffortState(descriptor, "Ultrathink:\nReview this code")).toEqual({
      controlled: true,
      inBodyText: false,
      value: "ultrathink",
    });
    expect(descriptor.currentValue).toBe("max");
    expect(resolveProviderPromptEffortState(descriptor, "Review this code").value).toBe("max");
  });

  it("inserts and removes only the injected prefix", () => {
    const change = { descriptor, primaryDescriptor: descriptor, value: "ultrathink", prompt: "" };
    expect(resolveProviderSelectChange(change)).toEqual({
      applyOption: false,
      prompt: "Ultrathink:\n",
    });
    expect(
      resolveProviderSelectChange({
        ...change,
        value: "max",
        prompt: "Ultrathink:\nReview this code",
      }),
    ).toEqual({ applyOption: true, prompt: "Review this code" });
  });

  it("keeps body-text effort and unrelated option changes intact", () => {
    const input = {
      descriptor,
      primaryDescriptor: descriptor,
      value: "high",
      prompt: "Please ultrathink about this",
    };
    expect(resolveProviderSelectChange(input)).toBeNull();
    expect(
      resolveProviderSelectChange({ ...input, descriptor: { ...descriptor, id: "contextWindow" } }),
    ).toEqual({ applyOption: true, prompt: null });
    expect(resolveProviderPromptEffortState(descriptor, input.prompt, false).value).toBe("max");
  });
});
