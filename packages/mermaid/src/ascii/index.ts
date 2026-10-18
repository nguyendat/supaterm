import { RenderBudget, checkLimit, validateSource } from "../budget.ts";
import { MERMAID_LIMITS as limits } from "../limits.ts";
import { detectDiagramType } from "../diagram-type.ts";
import { parseMermaid } from "../parser.ts";
import { convertToAsciiGraph } from "./converter.ts";
import { createMapping } from "./grid.ts";
import { drawGraph } from "./draw.ts";
import { canvasToString, flipCanvasVertically, flipTextVertically } from "./canvas.ts";
import { renderSequenceAscii } from "./sequence.ts";
import { renderClassAscii } from "./class-diagram.ts";
import { renderErAscii } from "./er-diagram.ts";
import { renderXYChartAscii } from "./xychart.ts";
import type { AsciiConfig } from "./types.ts";
export interface AsciiRenderOptions {
  useAscii?: boolean;
  paddingX?: number;
  paddingY?: number;
  boxBorderPadding?: number;
}
export function renderMermaidAscii(text: string, options: AsciiRenderOptions = {}): string {
  validateSource(text);
  if (options.useAscii !== undefined && typeof options.useAscii !== "boolean") {
    throw new TypeError("Mermaid useAscii must be a boolean");
  }
  for (const value of [options.paddingX, options.paddingY, options.boxBorderPadding]) {
    if (value !== undefined) checkLimit(value, limits.padding, "padding");
  }
  const config: AsciiConfig = {
    budget: new RenderBudget(),
    useAscii: options.useAscii ?? false,
    paddingX: options.paddingX ?? 5,
    paddingY: options.paddingY ?? 5,
    boxBorderPadding: options.boxBorderPadding ?? 1,
    graphDirection: "TD",
  };
  const output = renderDiagram(text, config);
  config.budget?.check();
  return output;
}
function renderDiagram(text: string, config: AsciiConfig): string {
  const diagramType = detectDiagramType(text);
  switch (diagramType) {
    case "xychart":
      return renderXYChartAscii(text, config);
    case "sequence":
      return renderSequenceAscii(text, config);
    case "class":
      return renderClassAscii(text, config);
    case "er":
      return renderErAscii(text, config);
    case "flowchart":
    default: {
      const parsed = parseMermaid(text);
      if (parsed.direction === "LR" || parsed.direction === "RL") {
        config.graphDirection = "LR";
      } else {
        config.graphDirection = "TD";
      }
      const graph = convertToAsciiGraph(parsed, config);
      if (parsed.direction === "BT") {
        for (const node of graph.nodes) node.displayLabel = flipTextVertically(node.displayLabel);
        for (const edge of graph.edges) edge.text = flipTextVertically(edge.text);
        for (const subgraph of graph.subgraphs) subgraph.name = flipTextVertically(subgraph.name);
      }
      createMapping(graph);
      drawGraph(graph);
      if (parsed.direction === "BT") {
        flipCanvasVertically(graph.canvas);
      }
      return canvasToString(graph.canvas);
    }
  }
}
