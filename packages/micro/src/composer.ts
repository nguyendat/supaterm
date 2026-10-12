import type {
  KeybindingCommand,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@supacode/contracts";
import {
  getSpeedToggle,
  getSpeedToggleNextValue,
} from "@supacode/client-runtime/provider-speed-toggle";
import { buildProviderOptionSelectionsFromDescriptors } from "@supacode/shared/model";
import {
  replaceDescriptorCurrentValue,
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

export function resolveMicroComposerChange(
  provider: string,
  descriptors: readonly ProviderOptionDescriptor[],
  action: MicroAction,
  prompt = "",
) {
  if (action.type === "fast") {
    const toggle = getSpeedToggle(provider, descriptors);
    if (!toggle) return null;
    return {
      prompt: null,
      options: buildProviderOptionSelectionsFromDescriptors(
        replaceDescriptorCurrentValue(
          descriptors,
          toggle.descriptorId,
          getSpeedToggleNextValue(toggle),
        ),
      ),
    };
  }
  if (action.type !== "effort") return null;
  const descriptor = descriptors.find(
    (option) =>
      option.type === "select" && ["effort", "reasoningEffort", "variant"].includes(option.id),
  );
  if (!descriptor || descriptor.type !== "select") return null;
  const promptState = resolveProviderPromptEffortState(descriptor, prompt);
  if (promptState.inBodyText) return null;
  const index = descriptor.options.findIndex((option) => option.id === promptState.value);
  if (index < 0) return null;
  const next = descriptor.options[index + action.direction];
  if (!next) return null;
  const transition = resolveProviderSelectChange({
    descriptor,
    primaryDescriptor: descriptor,
    value: next.id,
    prompt,
  });
  if (!transition) return null;
  return {
    prompt: transition.prompt,
    options: transition.applyOption
      ? buildProviderOptionSelectionsFromDescriptors(
          replaceDescriptorCurrentValue(descriptors, descriptor.id, next.id),
        )
      : null,
  };
}

export function useMicroComposer(input: {
  readonly enabled?: boolean;
  readonly provider: string;
  readonly readDescriptors: () => readonly ProviderOptionDescriptor[];
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
    if (action.type !== "fast" && action.type !== "effort") return;
    const change = resolveMicroComposerChange(
      input.provider,
      input.readDescriptors(),
      action,
      input.prompt,
    );
    if (!change) return;
    if (change.prompt !== null) input.writePrompt(change.prompt);
    if (change.options !== null) input.writeOptions(change.options);
  }, input.enabled);
}
