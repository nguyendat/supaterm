import type {
  KeybindingCommand,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@supacode/contracts";
import {
  getSpeedToggle,
  getSpeedToggleNextValue,
} from "@supacode/client-runtime/provider-speed-toggle";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
} from "@supacode/shared/model";
import {
  resolveProviderPromptEffortState,
  resolveProviderSelectChange,
} from "@supacode/client-runtime/provider-traits";
import type { MicroAction } from "./input.ts";
import { useMicroActions } from "./react.ts";

const JOYSTICK_CONTROLS = {
  up: "composer.effort",
  right: "modelPicker.toggle",
  down: "composer.host",
  left: "composer.workspace",
} as const;

export function resolveMicroOptionChange(
  provider: string,
  descriptors: readonly ProviderOptionDescriptor[],
  action: MicroAction,
  prompt = "",
) {
  if (action.type === "fast") {
    const toggle = getSpeedToggle(provider, descriptors);
    return toggle ? { id: toggle.descriptorId, value: getSpeedToggleNextValue(toggle) } : null;
  }
  if (action.type !== "effort") return null;
  const descriptor = descriptors.find(
    (option) =>
      option.type === "select" && ["effort", "reasoningEffort", "variant"].includes(option.id),
  );
  if (!descriptor || descriptor.type !== "select") return null;
  const promptState = resolveProviderPromptEffortState(descriptor, prompt);
  if (promptState.inBodyText) return null;
  const current = promptState.value ?? getProviderOptionCurrentValue(descriptor);
  const index = descriptor.options.findIndex((option) => option.id === current);
  if (index < 0) return null;
  const next = descriptor.options[index + action.direction];
  if (!next) return null;
  return {
    id: descriptor.id,
    value: next.id,
  };
}

export function useMicroComposer(input: {
  readonly provider: string;
  readonly descriptors: readonly ProviderOptionDescriptor[];
  readonly prompt: string;
  readonly writeOptions: (options: readonly ProviderOptionSelection[] | undefined) => void;
  readonly writePrompt: (prompt: string) => void;
  readonly submit: () => void;
  readonly focus: () => void;
  readonly openControl: (command: KeybindingCommand) => void;
}) {
  useMicroActions((action) => {
    if (!document.hasFocus()) return;
    if (action.type === "send") {
      input.submit();
      return;
    }
    if (action.type === "focus") {
      input.focus();
      return;
    }
    if (action.type === "effortMenu") {
      input.openControl("composer.effort");
      return;
    }
    if (action.type === "joystick") {
      input.openControl(JOYSTICK_CONTROLS[action.direction]);
      return;
    }
    const change = resolveMicroOptionChange(
      input.provider,
      input.descriptors,
      action,
      input.prompt,
    );
    if (!change) return;
    const descriptor = input.descriptors.find((option) => option.id === change.id);
    if (descriptor?.type === "select" && typeof change.value === "string") {
      const primary = input.descriptors.find((option) => option.type === "select") ?? null;
      const transition = resolveProviderSelectChange({
        descriptor,
        primaryDescriptor: primary?.type === "select" ? primary : null,
        value: change.value,
        prompt: input.prompt,
      });
      if (!transition) return;
      if (transition.prompt !== null) input.writePrompt(transition.prompt);
      if (!transition.applyOption) return;
    }
    input.writeOptions(
      buildProviderOptionSelectionsFromDescriptors(
        input.descriptors.map((option) => {
          if (option.id !== change.id) return option;
          if (option.type === "boolean" && typeof change.value === "boolean")
            return { ...option, currentValue: change.value };
          if (option.type === "select" && typeof change.value === "string")
            return { ...option, currentValue: change.value };
          return option;
        }),
      ),
    );
  });
}
