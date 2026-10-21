// @vitest-environment jsdom
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { act, createContext, use } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  params: { path: ["first", "guide.pdf"] },
  renderedItems: [] as NativeStackHeaderItem[],
  appliedOptions: {} as Record<string, unknown>,
  setOptionsCalls: 0,
  openedDocuments: [] as string[],
}));

vi.mock("@react-navigation/native", () => {
  const navigation = {
    setOptions(options: {
      unstable_headerLeftItems?: () => NativeStackHeaderItem[];
      unstable_headerRightItems?: () => NativeStackHeaderItem[];
      unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
    }) {
      harness.setOptionsCalls += 1;
      const merged = { ...harness.appliedOptions, ...options };
      // React Navigation reuses a screen's descriptor while every option value is identical.
      if (
        Object.entries(merged).every(([key, value]) =>
          Object.is(harness.appliedOptions[key], value),
        )
      )
        return;
      harness.appliedOptions = merged;
      harness.renderedItems =
        merged.unstable_headerLeftItems?.() ??
        merged.unstable_headerRightItems?.() ??
        merged.unstable_headerToolbarItems?.() ??
        [];
    },
  };
  return {
    useNavigation: () => navigation,
    useRoute: () => ({ key: "file", name: "ThreadFile", params: harness.params }),
  };
});

import { NativeHeaderToolbar } from "./NativeHeaderToolbar";

let root: Root | null = null;
type Placement = "left" | "right" | "bottom";

function DocumentToolbar(props: { readonly path: string; readonly placement: Placement }) {
  return (
    <NativeHeaderToolbar placement={props.placement}>
      <NativeHeaderToolbar.Menu title="File actions" icon="ellipsis">
        <NativeHeaderToolbar.MenuAction onPress={() => harness.openedDocuments.push(props.path)}>
          Open PDF
        </NativeHeaderToolbar.MenuAction>
      </NativeHeaderToolbar.Menu>
    </NativeHeaderToolbar>
  );
}

function renderDocument(path: string, placement: Placement) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.params = { path: path.split("/") };
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(<DocumentToolbar path={path} placement={placement} />));
}

function openRenderedDocument() {
  const menu = harness.renderedItems[0];
  if (menu?.type !== "menu") throw new Error("Expected the native file menu");
  const action = menu.menu.items[0];
  if (action?.type !== "action") throw new Error("Expected the native Open PDF action");
  action.onPress?.();
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.renderedItems = [];
  harness.appliedOptions = {};
  harness.setOptionsCalls = 0;
  harness.openedDocuments = [];
  vi.unstubAllGlobals();
});

it.each(["left", "right", "bottom"] as const)(
  "updates the %s header action when switching between documents with the same name",
  (placement) => {
    renderDocument("first/guide.pdf", placement);
    openRenderedDocument();
    renderDocument("second/guide.pdf", placement);
    openRenderedDocument();

    expect(harness.openedDocuments).toEqual(["first/guide.pdf", "second/guide.pdf"]);
  },
);

it.each(["left", "right", "bottom"] as const)(
  "does not reapply %s header options for equivalent document renders",
  (placement) => {
    renderDocument("first/guide.pdf", placement);
    const applied = harness.setOptionsCalls;
    renderDocument("first/guide.pdf", placement);
    renderDocument("first/guide.pdf", placement);

    expect(harness.setOptionsCalls).toBe(applied);
    openRenderedDocument();
    expect(harness.openedDocuments).toEqual(["first/guide.pdf"]);
  },
);

function AgentToolbar(props: { readonly ready: boolean }) {
  return (
    <NativeHeaderToolbar placement="bottom">
      <NativeHeaderToolbar.Button
        label="Work on PR"
        disabled={!props.ready}
        onPress={() => harness.openedDocuments.push("work")}
      />
    </NativeHeaderToolbar>
  );
}

it("enables a toolbar action that rendered disabled while its data loaded", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<AgentToolbar ready={false} />));
  act(() => root!.render(<AgentToolbar ready />));

  const button = harness.renderedItems[0];
  if (button?.type !== "button") throw new Error("Expected the native toolbar button");
  expect(button.disabled).toBe(false);
  button.onPress();
  expect(harness.openedDocuments).toEqual(["work"]);
});

const HeaderContext = createContext({
  get options(): never {
    throw new Error("Navigation context must not be traversed");
  },
});

function CustomHeader(props: { readonly path: string }) {
  use(HeaderContext);
  return (
    <NativeHeaderToolbar placement="right">
      <NativeHeaderToolbar.Custom>
        <button onClick={() => harness.openedDocuments.push(props.path)}>Open document</button>
      </NativeHeaderToolbar.Custom>
    </NativeHeaderToolbar>
  );
}

it("keeps custom header controls working across document changes", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  for (const path of ["first/guide.pdf", "second/guide.pdf"]) {
    harness.params = { path: path.split("/") };
    act(() => root!.render(<CustomHeader path={path} />));
    const custom = harness.renderedItems[0];
    if (custom?.type !== "custom") throw new Error("Expected custom native header control");
    const container = document.createElement("div");
    const controlRoot = createRoot(container);
    act(() => controlRoot.render(custom.element));
    act(() => container.querySelector("button")!.click());
    act(() => controlRoot.unmount());
  }
  expect(harness.openedDocuments).toEqual(["first/guide.pdf", "second/guide.pdf"]);
});
