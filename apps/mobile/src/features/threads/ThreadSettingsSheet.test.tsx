import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection } from "@supaterm/contracts";

const harness = vi.hoisted(() => ({ platform: "ios" }));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return harness.platform;
    },
  },
  View: "div",
  ScrollView: "div",
  TextInput: "input",
  RefreshControl: () => null,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      role={props.accessibilityRole}
      aria-checked={props.accessibilityState?.checked}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("@legendapp/list/reanimated", () => ({
  AnimatedLegendList: (props: {
    data: Array<{ key: string }>;
    renderItem: (input: { item: { key: string } }) => ReactNode;
  }) => props.data.map((item) => <div key={item.key}>{props.renderItem({ item })}</div>),
}));
vi.mock("../../native/createV5StackNavigator", () => ({
  createV5StackNavigator: () => ({
    Navigator: ({ children }: { children: ReactNode }) => children,
    Screen: ({ name, component: Screen }: { name: string; component: () => ReactNode }) =>
      name === "ThreadSettingsModels" ? <Screen /> : null,
  }),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  nativeHeaderScrollEdgeEffects: () => ({}),
}));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../native/use-native-mail-search-toolbar", () => ({
  useNativeMailSearchToolbar: () => true,
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET: 0,
}));
vi.mock("../../components/ui/SheetHeader", () => ({
  SheetHeader: (props: { onCancel?: () => void; onClose?: () => void }) => (
    <button onClick={props.onClose ?? props.onCancel}>Close picker</button>
  ),
}));
vi.mock("../../components/ui/Toolbar", () => ({ Toolbar: () => null }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/AndroidAnchoredMenu", () => ({ AndroidAnchoredMenu: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../components/ui/DisclosureChevron", () => ({ DisclosureChevron: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      type="checkbox"
      checked={props.value}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("./ReasoningSliderRow", () => ({ ReasoningSliderRow: () => null }));
vi.mock("./ChatGptSharingStatus", () => ({ ChatGptSharingStatus: () => null }));
vi.mock("./use-thread-list-motion", () => ({ useThreadListMotion: () => ({}) }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()), serverEnvironment: {} };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("../../state/use-model-option-memory", () => ({
  withRememberedModelOptions: (selection: unknown) => selection,
}));
vi.mock("./new-task-flow-provider", () => ({ useNewTaskFlow: () => ({}) }));

import type { ModelOption } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { ThreadSettingsPickerScreen } from "./ThreadSettingsSheet";

function modelOption(model: string, instanceId = "codex"): ModelOption {
  return {
    key: `${instanceId}:${model}`,
    label: model,
    subtitle: "",
    providerKey: instanceId,
    providerLabel: instanceId,
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: {
      optionDescriptors: [{ id: "fast", label: `${model} fast mode`, type: "boolean" }],
    },
    selection: { instanceId: ProviderInstanceId.make(instanceId), model },
  };
}
const original = modelOption("Original");
const next = modelOption("Next");
const other = modelOption("Other", "work");
const groups = [
  { providerKey: "codex", providerLabel: "Codex", models: [original, next] },
  { providerKey: "work", providerLabel: "Work", models: [other] },
];

function Composer(props: { readonly rememberedOptions: boolean }) {
  const [selection, setSelection] = useState<ModelSelection>({
    ...original.selection,
    options: [{ id: "fast", value: true }],
  });
  const [open, setOpen] = useState(true);
  const option = groups
    .flatMap((group) => group.models)
    .find(
      (model) =>
        model.selection.instanceId === selection.instanceId &&
        model.selection.model === selection.model,
    );
  return (
    <>
      <output>{selection.model}</output>
      <button onClick={() => setOpen(true)}>Open picker</button>
      {open ? (
        <ThreadSettingsPickerScreen
          environmentId={null}
          projectId={null}
          providerGroups={groups}
          selectedModel={selection}
          onSelectModel={setSelection}
          restoreSelection={
            props.rememberedOptions
              ? (model) => ({
                  ...model,
                  options: [{ id: "fast", value: model.model !== "Original" }],
                })
              : undefined
          }
          optionDescriptors={resolveProviderOptionDescriptors({
            capabilities: option?.capabilities,
            selections: selection.options,
          })}
          onUpdateOptionSelections={(options) => setSelection({ ...selection, options })}
          runtimeMode="full-access"
          onUpdateRuntimeMode={() => {}}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

let root: Root | null = null;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});
function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === label || element.textContent === label,
  );
  expect(button, label).toBeDefined();
  act(() => button!.click());
}
function fastMode(model = "Next") {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${model} fast mode"]`);
  expect(input).not.toBeNull();
  return input!;
}

describe("mobile model picker", () => {
  it.each([
    { platform: "ios", rememberedOptions: true },
    { platform: "android", rememberedOptions: true },
    { platform: "ios", rememberedOptions: false },
    { platform: "android", rememberedOptions: false },
  ])(
    "retains selections on $platform with option memory $rememberedOptions",
    ({ platform, rememberedOptions }) => {
      harness.platform = platform;
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      container = document.createElement("div");
      root = createRoot(container);
      act(() => root!.render(<Composer rememberedOptions={rememberedOptions} />));
      click("Next");
      expect(container.querySelector("output")?.textContent).toBe("Next");
      expect(fastMode().checked).toBe(rememberedOptions);
      act(() => fastMode().click());
      click("Next");
      expect(fastMode().checked).toBe(!rememberedOptions);
      click("Original");
      expect(fastMode("Original").checked).toBe(true);
      click("Next");
      expect(fastMode().checked).toBe(!rememberedOptions);
      click("Close picker");
      click("Open picker");
      expect(container.querySelector('[aria-label="Next"]')?.getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(fastMode().checked).toBe(!rememberedOptions);
      click("Other");
      click("Close picker");
      expect(container.querySelector("output")?.textContent).toBe("Other");
      click("Open picker");
      expect(container.querySelector('[aria-label="Other"]')?.getAttribute("aria-checked")).toBe(
        "true",
      );
      click("Original");
      expect(container.querySelector("output")?.textContent).toBe("Original");
    },
  );
});
