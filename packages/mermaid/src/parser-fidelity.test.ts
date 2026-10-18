import { describe, expect, it } from "vite-plus/test";
import { renderMermaidAscii } from "./ascii/index.ts";
import { parseMermaid } from "./parser.ts";

describe("flowchart source fidelity", () => {
  it("renders every statement separated by semicolons", () => {
    const compact = "graph TD; A --> B; B --> C;";
    const expanded = "graph TD\nA --> B\nB --> C";
    expect(parseMermaid(compact)).toEqual(parseMermaid(expanded));
    expect(renderMermaidAscii(compact)).toBe(renderMermaidAscii(expanded));
  });

  it.each(["-->", "---", "==>", "===", "-.->", "-.-", "<-->"])(
    "preserves statement boundaries after %s edges",
    (arrow) => {
      const compact = `graph TD; A ${arrow} B; B --> C`;
      const expanded = `graph TD\nA ${arrow} B\nB --> C`;
      expect(parseMermaid(compact)).toEqual(parseMermaid(expanded));
    },
  );

  it.each([
    ["A[First; second]", "First; second"],
    ['A["First; second"]', "First; second"],
    ["A(First; second)", "First; second"],
    ["A{{First; second}}", "First; second"],
    ["A>First; second]", "First; second"],
  ])("preserves separators in node labels: %s", (declaration, label) => {
    const graph = parseMermaid(`graph TD; ${declaration} --> B; B --> C`);
    expect(graph.nodes.get("A")?.label).toBe(label);
    expect(graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ["A", "B"],
      ["B", "C"],
    ]);
  });

  it.each(["-->|First; second|", '-- "First; second" -->', "-- First; second -->"])(
    "preserves separators in edge labels: %s",
    (arrow) => {
      const graph = parseMermaid(`graph TD; A ${arrow} B; B --> C`);
      expect(graph.edges.map(({ source, target, label }) => ({ source, target, label }))).toEqual([
        { source: "A", target: "B", label: "First; second" },
        { source: "B", target: "C", label: undefined },
      ]);
    },
  );

  it("preserves styles, subgraphs, and comments around statement separators", () => {
    const compact =
      "graph TD; subgraph S[Group; label]; A --> B; end; classDef hot fill:red; class A hot; %% ignored; C";
    const expanded =
      "graph TD\nsubgraph S[Group; label]\nA --> B\nend\nclassDef hot fill:red\nclass A hot";
    expect(parseMermaid(compact)).toEqual(parseMermaid(expanded));
  });

  it.each([
    'A@{ shape: rect, label: "Server" } --> B',
    "A --> B unsupported",
    "A -->",
    "A &",
    "A --> B &",
    "?unsupported",
  ])("rejects unsupported syntax instead of returning a partial diagram: %s", (statement) => {
    const source = `graph TD\n${statement}`;
    expect(() => parseMermaid(source)).toThrow();
    expect(() => renderMermaidAscii(source)).toThrow();
  });

  it("updates explicit labels and shapes without changing node order or bare references", () => {
    const source = "graph TD\nA --> B\nB[Worker] --> C[Done]\nB(Final worker)\nB --> C";
    const graph = parseMermaid(source);
    expect([...graph.nodes.keys()]).toEqual(["A", "B", "C"]);
    expect(graph.nodes.get("B")).toEqual({
      id: "B",
      label: "Final worker",
      shape: "rounded",
    });
    expect(renderMermaidAscii(source)).toContain("Final worker");
  });
});

describe("state declaration source fidelity", () => {
  it("updates explicit descriptions after transitions without losing composite membership", () => {
    const source =
      'stateDiagram-v2\nstate Group {\nA --> B\nB: Worker\nstate "Final worker" as B\nB --> C\n}';
    const graph = parseMermaid(source);
    expect(graph.nodes.get("B")).toEqual({
      id: "B",
      label: "Final worker",
      shape: "rounded",
    });
    expect(graph.subgraphs[0]?.nodeIds).toEqual(["A", "B", "C"]);
    expect(renderMermaidAscii(source)).toContain("Final worker");
  });
});
