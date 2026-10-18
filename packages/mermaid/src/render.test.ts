import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderMermaidAscii } from "./ascii/index.ts";
import { parseMermaid } from "./parser.ts";
import { convertToAsciiGraph } from "./ascii/converter.ts";
import { createMapping } from "./ascii/grid.ts";
import { drawGraph } from "./ascii/draw.ts";
import { canvasToString } from "./ascii/canvas.ts";

const normalize = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

const fixtures = import.meta.glob<string>("./testdata/{ascii,unicode}/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe.each([["ascii"], ["unicode"]] as const)("%s reference output", (mode) => {
  const cases = Object.entries(fixtures).filter(([file]) => file.startsWith(`./testdata/${mode}/`));
  it.each(cases)("%s", (file, content) => {
    const separator = content.indexOf("\n---\n");
    expect(separator).toBeGreaterThan(0);
    const padding: { paddingX?: number; paddingY?: number } = {};
    const source = content
      .slice(0, separator)
      .replace(/^padding([xy])\s*=\s*(\d+)\s*$/gim, (_, axis: string, value: string) => {
        padding[axis.toLowerCase() === "x" ? "paddingX" : "paddingY"] = Number(value);
        return "";
      });
    const expected = content.slice(separator + 5);
    expect(normalize(renderMermaidAscii(source, { useAscii: mode === "ascii", ...padding }))).toBe(
      normalize(expected),
    );
  });
});

describe.each(["TD", "LR"] as const)("deep %s layout", (graphDirection) => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([25, 26, 100])("renders a %i-node chain with finite coordinates", (nodeCount) => {
    const source = `graph ${graphDirection}\n${Array.from({ length: nodeCount - 1 }, (_, index) => `N${index} --> N${index + 1}`).join("\n")}`;
    const graph = convertToAsciiGraph(parseMermaid(source), {
      graphDirection,
      useAscii: false,
      paddingX: 5,
      paddingY: 5,
      boxBorderPadding: 1,
    });
    const set = graph.grid.set.bind(graph.grid);
    graph.grid.set = (key, node) => {
      expect(key.split(",").every((coordinate) => Number.isFinite(Number(coordinate)))).toBe(true);
      return set(key, node);
    };
    createMapping(graph);
    expect(graph.nodes).toHaveLength(nodeCount);
    for (const node of graph.nodes) {
      expect(Number.isFinite(node.drawingCoord?.x)).toBe(true);
      expect(Number.isFinite(node.drawingCoord?.y)).toBe(true);
    }
    for (const edge of graph.edges) expect(edge.path.length).toBeGreaterThan(0);
    drawGraph(graph);
    const output = canvasToString(graph.canvas);
    for (let index = 0; index < nodeCount; index++) expect(output).toContain(`N${index}`);
  });
});

describe("plain text API", () => {
  it("returns Unicode by default and keeps ASCII options local to the call", () => {
    const source = "graph LR\nA --> B";
    const unicode = renderMermaidAscii(source);
    expect(unicode).toContain("┌───┐");
    expect(renderMermaidAscii(source, { useAscii: true })).toContain("+---+");
    expect(renderMermaidAscii(source)).toBe(unicode);
    expect(unicode).not.toContain("<span");
    expect(unicode).not.toContain(String.fromCharCode(27));
  });

  it("renders state transitions", () => {
    const output = renderMermaidAscii(
      "stateDiagram-v2\n[*] --> Idle\nIdle --> Running\nRunning --> [*]",
    );
    expect(output).toContain("Idle");
    expect(output).toContain("Running");
    expect(output.indexOf("Idle")).toBeLessThan(output.indexOf("Running"));
  });

  it("renders XY bars with labels and a numeric axis", () => {
    const output = renderMermaidAscii(
      'xychart-beta\ntitle "Sales"\nx-axis [Jan, Feb]\ny-axis 0 --> 100\nbar [25, 75]',
      { useAscii: true },
    );
    for (const label of ["Sales", "Jan", "Feb", "100", "#"]) expect(output).toContain(label);
    expect(output).not.toContain("<span");
  });

  it("reports unsupported diagram headers", () => {
    expect(() => renderMermaidAscii('pie\n"One" : 1')).toThrow();
  });
});
