import type { ProviderOptionDescriptor } from "@supacode/contracts";
import {
  applyClaudePromptEffortPrefix,
  getProviderOptionCurrentValue,
  isClaudeUltrathinkPrompt,
} from "@supacode/shared/model";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

export function replaceDescriptorCurrentValue(
  descriptors: readonly ProviderOptionDescriptor[],
  descriptorId: string,
  currentValue: string | boolean | undefined,
) {
  return descriptors.map((descriptor) => {
    if (descriptor.id !== descriptorId) return descriptor;
    if (descriptor.type === "boolean" && typeof currentValue === "boolean")
      return { ...descriptor, currentValue };
    if (descriptor.type === "select" && typeof currentValue === "string")
      return { ...descriptor, currentValue };
    return descriptor;
  });
}

export function resolveProviderPromptEffortState(
  descriptor: SelectDescriptor | null,
  prompt: string,
  allowed = true,
) {
  const controlled =
    allowed &&
    (descriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const inBodyText = controlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const current = descriptor ? getProviderOptionCurrentValue(descriptor) : null;
  return {
    controlled,
    inBodyText,
    value: controlled ? "ultrathink" : typeof current === "string" ? current : null,
  };
}

export function resolveProviderSelectChange(input: {
  readonly descriptor: SelectDescriptor;
  readonly primaryDescriptor: SelectDescriptor | null;
  readonly value: string;
  readonly prompt: string;
  readonly allowPromptInjectedEffort?: boolean;
}) {
  if (!input.value) return null;
  if (input.descriptor.promptInjectedValues?.includes(input.value)) {
    return {
      applyOption: false,
      prompt: input.prompt.trim()
        ? applyClaudePromptEffortPrefix(input.prompt, "ultrathink")
        : "Ultrathink:\n",
    };
  }
  const state = resolveProviderPromptEffortState(
    input.primaryDescriptor,
    input.prompt,
    input.allowPromptInjectedEffort,
  );
  const primary = input.descriptor.id === input.primaryDescriptor?.id;
  if (primary && state.inBodyText) return null;
  return {
    applyOption: true,
    prompt: primary && state.controlled ? input.prompt.replace(/^Ultrathink:\s*/i, "") : null,
  };
}
