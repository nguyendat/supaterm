import { validateSource } from "./budget.ts";
import { layoutClassDiagramSync } from "./class/layout.ts";
import { parseClassDiagram } from "./class/parser.ts";
import { renderClassSvg } from "./class/renderer.ts";
import { detectDiagramType } from "./diagram-type.ts";
import { layoutErDiagramSync } from "./er/layout.ts";
import { parseErDiagram } from "./er/parser.ts";
import { renderErSvg } from "./er/renderer.ts";
import { layoutGraphSync } from "./layout-engine.ts";
import { parseMermaid } from "./parser.ts";
import { renderSvg } from "./renderer.ts";
import { layoutSequenceDiagram } from "./sequence/layout.ts";
import { parseSequenceDiagram } from "./sequence/parser.ts";
import { renderSequenceSvg } from "./sequence/renderer.ts";
import type { DiagramColors } from "./theme.ts";
import { layoutXYChart } from "./xychart/layout.ts";
import { parseXYChart } from "./xychart/parser.ts";
import { renderXYChartSvg } from "./xychart/renderer.ts";

export type { DiagramColors };

export interface SvgRenderOptions {
  colors: DiagramColors;
  font: string;
}

export function renderMermaidSvg(text: string, { colors, font }: SvgRenderOptions): string {
  validateSource(text);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));
  switch (detectDiagramType(text)) {
    case "sequence": {
      const diagram = parseSequenceDiagram(lines);
      if (diagram.actors.length === 0) return "";
      return renderSequenceSvg(layoutSequenceDiagram(diagram), colors, font, true);
    }
    case "class": {
      const diagram = parseClassDiagram(lines);
      if (diagram.classes.length === 0) return "";
      return renderClassSvg(layoutClassDiagramSync(diagram), colors, font, true);
    }
    case "er": {
      const diagram = parseErDiagram(lines);
      if (diagram.entities.length === 0) return "";
      return renderErSvg(layoutErDiagramSync(diagram), colors, font, true);
    }
    case "xychart":
      return renderXYChartSvg(layoutXYChart(parseXYChart(lines)), colors, font, true);
    case "flowchart": {
      const graph = parseMermaid(text);
      if (graph.nodes.size === 0) return "";
      return renderSvg(layoutGraphSync(graph), colors, font, true);
    }
  }
}
