import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Button } from "../components/ui/button";
import { MermaidBlock } from "./MermaidBlock";
import { renderMermaidDiagram } from "./mermaidRenderer";

vi.mock("./mermaidRenderer", () => ({ renderMermaidDiagram: vi.fn() }));
vi.mock("../components/ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../components/ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(private readonly report: (entries: Array<{ isIntersecting: boolean }>) => void) {
    TestIntersectionObserver.instances.push(this);
  }

  visible(value: boolean) {
    this.report([{ isIntersecting: value }]);
  }
}

let renderer: ReactTestRenderer | undefined;
let shadowRoots: Array<{ innerHTML: string }> = [];

beforeEach(() => {
  TestIntersectionObserver.instances = [];
  shadowRoots = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  vi.mocked(renderMermaidDiagram).mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function mount(source: string, complete = true) {
  await act(async () => {
    renderer = create(<MermaidBlock source={source} complete={complete} title={null} />, {
      createNodeMock: () => ({
        shadowRoot: null as { innerHTML: string } | null,
        attachShadow() {
          this.shadowRoot = { innerHTML: "" };
          shadowRoots.push(this.shadowRoot);
          return this.shadowRoot;
        },
      }),
    });
  });
}

function displayedText() {
  const code = renderer!.root.findAllByType("code")[0];
  if (code) return code.children.join("");
  return shadowRoots.at(-1)?.innerHTML.replace(/^<style>.*?<\/style>/, "");
}

function button(label: string) {
  const found = renderer!.root
    .findAllByType(Button)
    .find((item) => item.props.children === label || item.props["aria-label"] === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found.props as ComponentProps<typeof Button>;
}

function deferredResult() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("MermaidBlock", () => {
  it("renders only a completed, visible fence", async () => {
    vi.mocked(renderMermaidDiagram).mockResolvedValue("diagram");
    await mount("graph TD\n A-->B", false);
    expect(displayedText()).toBe("graph TD\n A-->B");
    await act(async () => TestIntersectionObserver.instances[0]!.visible(true));
    expect(renderMermaidDiagram).not.toHaveBeenCalled();
    await act(async () => {
      renderer!.update(<MermaidBlock source={"graph TD\n A-->B"} complete title={null} />);
    });
    expect(displayedText()).toBe("diagram");
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("preserves source until visible and copies the source from either view", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(renderMermaidDiagram).mockResolvedValue("<svg>A</svg>");
    await mount("graph TD\n A");
    expect(renderMermaidDiagram).not.toHaveBeenCalled();
    await act(async () => TestIntersectionObserver.instances[0]!.visible(true));
    expect(displayedText()).toBe("<svg>A</svg>");
    await act(async () =>
      button("Copy source").onClick?.({} as React.MouseEvent<HTMLButtonElement>),
    );
    expect(writeText).toHaveBeenLastCalledWith("graph TD\n A");
    await act(async () => button("Source").onClick?.({} as React.MouseEvent<HTMLButtonElement>));
    expect(displayedText()).toBe("graph TD\n A");
    await act(async () => button("Diagram").onClick?.({} as React.MouseEvent<HTMLButtonElement>));
    expect(displayedText()).toBe("<svg>A</svg>");
    expect(shadowRoots).toHaveLength(2);
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("keeps original source after failure without retrying on ordinary rerenders", async () => {
    vi.mocked(renderMermaidDiagram).mockResolvedValue(null);
    await mount("unsupported");
    await act(async () => TestIntersectionObserver.instances[0]!.visible(true));
    await act(async () => {
      renderer!.update(<MermaidBlock source="unsupported" complete title="Example" />);
    });
    expect(displayedText()).toBe("unsupported");
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("copies the source on remote HTTP pages without the Clipboard API", async () => {
    const textarea = {
      value: "",
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    };
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      body: { appendChild: vi.fn() },
      createElement: () => textarea,
      execCommand,
    });
    vi.mocked(renderMermaidDiagram).mockResolvedValue("<svg>A</svg>");
    await mount("graph TD\n A");
    await act(async () => TestIntersectionObserver.instances[0]!.visible(true));
    await act(async () =>
      button("Copy source").onClick?.({} as React.MouseEvent<HTMLButtonElement>),
    );
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.value).toBe("graph TD\n A");
    expect(button("Copied")).toBeDefined();
  });

  it("ignores a result for an outdated source", async () => {
    const first = deferredResult();
    const second = deferredResult();
    vi.mocked(renderMermaidDiagram)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mount("first");
    await act(async () => TestIntersectionObserver.instances[0]!.visible(true));
    await act(async () => {
      renderer!.update(<MermaidBlock source="second" complete title={null} />);
      first.resolve("stale diagram");
    });
    expect(displayedText()).toBe("second");
    await act(async () => second.resolve("second diagram"));
    expect(displayedText()).toBe("second diagram");
  });
});
