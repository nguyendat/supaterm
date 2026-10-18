import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderMermaidAscii, type AsciiRenderOptions } from "./ascii/index.ts";
import { getPath } from "./ascii/pathfinder.ts";
import { convertToAsciiGraph } from "./ascii/converter.ts";
import { parseMermaid } from "./parser.ts";
import { RenderBudget } from "./budget.ts";
import { MERMAID_LIMITS as limits } from "./limits.ts";

afterEach(() => vi.restoreAllMocks());

describe("rendering limits", () => {
  it("rejects oversized source before parsing", () => {
    expect(() => renderMermaidAscii("x".repeat(limits.sourceChars + 1))).toThrow(/source length/);
    expect(() => renderMermaidAscii(`graph TD\n${"A".repeat(limits.lineChars + 1)}`)).toThrow(
      /line length/,
    );
  });

  it.each(["paddingX", "paddingY", "boxBorderPadding"] as const)(
    "rejects invalid %s values before layout",
    (option) => {
      for (const value of [NaN, Infinity, -Infinity, -1, 0.5, limits.padding + 1]) {
        const options: AsciiRenderOptions = { [option]: value };
        expect(() => renderMermaidAscii("graph TD\nA --> B", options)).toThrow(/padding/);
      }
    },
  );

  it("limits expanded edges in compact ampersand syntax", () => {
    const left = Array.from({ length: 17 }, (_, index) => `A${index}`).join(" & ");
    const right = Array.from({ length: 17 }, (_, index) => `B${index}`).join(" & ");
    expect(() => renderMermaidAscii(`graph TD\n${left} --> ${right}`)).toThrow(/edges/);
  });

  it("rejects too many nodes and excessive subgraph nesting", () => {
    const nodes = Array.from({ length: limits.nodes + 1 }, (_, index) => `N${index}`).join("\n");
    expect(() => renderMermaidAscii(`graph TD\n${nodes}`)).toThrow(/nodes/);
    const groups = Array.from(
      { length: limits.nesting + 1 },
      (_, index) => `subgraph S${index}`,
    ).join("\n");
    expect(() =>
      renderMermaidAscii(`graph TD\n${groups}\nA\n${"end\n".repeat(limits.nesting + 1)}`),
    ).toThrow(/nesting/);
  });

  it("rejects excessive output width before allocating its canvas", () => {
    const label = "x".repeat(1_200);
    expect(() => renderMermaidAscii(`graph LR\nA[${label}]\nB[${label}]\nA --> B`)).toThrow(
      /canvas width/,
    );
  });

  it("limits output area even when both dimensions are individually supported", () => {
    const label = "x".repeat(110);
    const source = `graph TD\n${Array.from({ length: 119 }, (_, index) => `N${index}[${label}] --> N${index + 1}`).join("\n")}`;
    expect(() => renderMermaidAscii(source)).toThrow(/canvas cells/);
  });

  it("accounts for cumulative allocations separately for each rendering", () => {
    const exhausted = new RenderBudget();
    const fresh = new RenderBudget();
    for (let index = 0; index < limits.allocatedCells / limits.canvasCells; index++) {
      exhausted.allocate(200, 500);
    }
    expect(() => exhausted.allocate(1, 1)).toThrow(/allocated cells/);
    expect(() => fresh.allocate(200, 500)).not.toThrow();
    expect(renderMermaidAscii("graph TD\nA --> B")).toContain("B");
  });

  it("checks the deadline without carrying it into another render", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const expired = new RenderBudget();
    now.mockReturnValue(1_001 + limits.durationMs);
    expect(() => expired.check()).toThrow(/time limit/);
    expect(renderMermaidAscii("graph TD\nA --> B")).toContain("B");
  });
});

describe("bounded routing", () => {
  it("terminates when the destination is enclosed by occupied cells", () => {
    const graph = convertToAsciiGraph(parseMermaid("graph TD\nA"), {
      graphDirection: "TD",
      useAscii: false,
      paddingX: 5,
      paddingY: 5,
      boxBorderPadding: 1,
    });
    for (const key of ["1,2", "3,2", "2,1", "2,3"]) graph.grid.set(key, graph.nodes[0]!);
    expect(getPath(graph.grid, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it.each([NaN, Infinity, -1, 0.5])("rejects invalid endpoint coordinate %s", (coordinate) => {
    expect(() => getPath(new Map(), { x: 0, y: 0 }, { x: coordinate, y: 1 })).toThrow(
      /path coordinate/,
    );
  });

  it("stops a search before exploring an excessive grid area", () => {
    const graph = convertToAsciiGraph(parseMermaid("graph TD\nA"), {
      graphDirection: "TD",
      useAscii: false,
      paddingX: 5,
      paddingY: 5,
      boxBorderPadding: 1,
    });
    for (const key of ["1999,2000", "2001,2000", "2000,1999", "2000,2001"]) {
      graph.grid.set(key, graph.nodes[0]!);
    }
    expect(() => getPath(graph.grid, { x: 0, y: 0 }, { x: 2_000, y: 2_000 })).toThrow(
      /path search/,
    );
  });
});

describe("bounded XY charts", () => {
  it.each([
    "bar [NaN]",
    "line [Infinity]",
    "bar [1e999]",
    "line [1, ]",
    "bar [1broken]",
    "y-axis NaN --> Infinity\nbar [1]",
    "y-axis 1 --> 1\nbar [1]",
    "y-axis 10 --> 0\nbar [1]",
    "x-axis [A, B]\nbar [1]",
    "bar [1e308, -1e308]",
  ])("rejects invalid chart data: %s", (source) => {
    expect(() => renderMermaidAscii(`xychart-beta\n${source}`)).toThrow();
  });

  it.each(["", " horizontal"])("clips out-of-range drawing coordinates%s", (direction) => {
    const output = renderMermaidAscii(
      `xychart-beta${direction}\nx-axis [A, B]\ny-axis 0 --> 1\nbar [1e300, -1e300]\nline [-1e300, 1e300]`,
    );
    expect(output).toContain("A");
    expect(output).toContain("B");
    expect(output.length).toBeLessThan(limits.canvasCells);
  });

  it("rejects tick intervals too small to represent", () => {
    expect(() => renderMermaidAscii("xychart-beta\ny-axis 0 --> 1e-323\nbar [0]")).toThrow(
      /tick interval/,
    );
  });
});
