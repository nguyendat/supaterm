import type {
  PositionedGraph,
  PositionedNode,
  PositionedEdge,
  PositionedGroup,
  Point,
} from "./types.ts";
import type { DiagramColors } from "./theme.ts";
import { svgOpenTag, buildStyleBlock } from "./theme.ts";
import { FONT_SIZES, FONT_WEIGHTS, STROKE_WIDTHS, ARROW_HEAD } from "./styles.ts";
import { measureMultilineText } from "./text-metrics.ts";
import { renderMultilineText, renderMultilineTextWithBackground } from "./multiline-utils.ts";
export function renderSvg(
  graph: PositionedGraph,
  colors: DiagramColors,
  font: string,
  transparent: boolean = false,
): string {
  const parts: string[] = [];
  parts.push(svgOpenTag(graph.width, graph.height, colors, transparent));
  parts.push(buildStyleBlock(font, false));
  parts.push("<defs>");
  parts.push(arrowMarkerDefs());
  const customStrokeColors = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.inlineStyle?.stroke) {
      customStrokeColors.add(edge.inlineStyle.stroke);
    }
  }
  for (const color of customStrokeColors) {
    parts.push(arrowMarkerDefsForColor(color));
  }
  parts.push("</defs>");
  for (const group of graph.groups) {
    parts.push(renderGroup(group));
  }
  for (const edge of graph.edges) {
    parts.push(renderEdge(edge));
  }
  for (const edge of graph.edges) {
    if (edge.label) {
      parts.push(renderEdgeLabel(edge));
    }
  }
  for (const node of graph.nodes) {
    parts.push(renderNode(node));
  }
  parts.push("</svg>");
  return parts.join("\n");
}
function arrowMarkerDefs(): string {
  const w = ARROW_HEAD.width;
  const h = ARROW_HEAD.height;
  const arrowStyle =
    'fill="var(--_arrow)" stroke="var(--_arrow)" stroke-width="0.75" stroke-linejoin="round"';
  const refX = w - 1;
  return (
    `  <marker id="arrowhead" markerWidth="${w}" markerHeight="${h}" refX="${refX}" refY="${h / 2}" orient="auto">` +
    `\n    <polygon points="0 0, ${w} ${h / 2}, 0 ${h}" ${arrowStyle} />` +
    `\n  </marker>` +
    `\n  <marker id="arrowhead-start" markerWidth="${w}" markerHeight="${h}" refX="1" refY="${h / 2}" orient="auto-start-reverse">` +
    `\n    <polygon points="${w} 0, 0 ${h / 2}, ${w} ${h}" ${arrowStyle} />` +
    `\n  </marker>`
  );
}
function arrowMarkerDefsForColor(color: string): string {
  const w = ARROW_HEAD.width;
  const h = ARROW_HEAD.height;
  const escaped = escapeAttr(color);
  const arrowStyle = `fill="${escaped}" stroke="${escaped}" stroke-width="0.75" stroke-linejoin="round"`;
  const refX = w - 1;
  const suffix = markerSuffix(color);
  return (
    `  <marker id="arrowhead-${suffix}" markerWidth="${w}" markerHeight="${h}" refX="${refX}" refY="${h / 2}" orient="auto">` +
    `\n    <polygon points="0 0, ${w} ${h / 2}, 0 ${h}" ${arrowStyle} />` +
    `\n  </marker>` +
    `\n  <marker id="arrowhead-start-${suffix}" markerWidth="${w}" markerHeight="${h}" refX="1" refY="${h / 2}" orient="auto-start-reverse">` +
    `\n    <polygon points="${w} 0, 0 ${h / 2}, ${w} ${h}" ${arrowStyle} />` +
    `\n  </marker>`
  );
}
function markerSuffix(color: string): string {
  return color.replace(/[^a-zA-Z0-9]/g, (ch) => ch.charCodeAt(0).toString(16));
}
function renderGroup(group: PositionedGroup): string {
  const headerHeight = FONT_SIZES.groupHeader + 16;
  const parts: string[] = [];
  parts.push(
    `<g class="subgraph" data-id="${escapeAttr(group.id)}" data-label="${escapeAttr(group.label)}">`,
  );
  parts.push(
    `  <rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" ` +
      `rx="0" ry="0" fill="var(--_group-fill)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
  );
  parts.push(
    `  <rect x="${group.x}" y="${group.y}" width="${group.width}" height="${headerHeight}" ` +
      `rx="0" ry="0" fill="var(--_group-hdr)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
  );
  parts.push(
    "  " +
      renderMultilineText(
        group.label,
        group.x + 12,
        group.y + headerHeight / 2,
        FONT_SIZES.groupHeader,
        `font-size="${FONT_SIZES.groupHeader}" font-weight="${FONT_WEIGHTS.groupHeader}" fill="var(--_text-sec)"`,
      ),
  );
  for (const child of group.children) {
    parts.push(renderGroup(child));
  }
  parts.push("</g>");
  return parts.join("\n");
}
function renderEdge(edge: PositionedEdge): string {
  if (edge.points.length < 2) return "";
  const pathData = pointsToPolylinePath(edge.points);
  const dashArray = edge.style === "dotted" ? ' stroke-dasharray="4 4"' : "";
  const baseStrokeWidth =
    edge.style === "thick" ? STROKE_WIDTHS.connector * 2 : STROKE_WIDTHS.connector;
  const strokeColor = escapeAttr(edge.inlineStyle?.stroke ?? "var(--_line)");
  const strokeWidth = escapeAttr(edge.inlineStyle?.["stroke-width"] ?? String(baseStrokeWidth));
  const suffix = edge.inlineStyle?.stroke ? `-${markerSuffix(edge.inlineStyle.stroke)}` : "";
  let markers = "";
  if (edge.hasArrowEnd) markers += ` marker-end="url(#arrowhead${suffix})"`;
  if (edge.hasArrowStart) markers += ` marker-start="url(#arrowhead-start${suffix})"`;
  const dataAttrs = [
    'class="edge"',
    `data-from="${escapeAttr(edge.source)}"`,
    `data-to="${escapeAttr(edge.target)}"`,
    `data-style="${edge.style}"`,
    `data-arrow-start="${edge.hasArrowStart}"`,
    `data-arrow-end="${edge.hasArrowEnd}"`,
  ];
  if (edge.label) {
    dataAttrs.push(`data-label="${escapeAttr(edge.label)}"`);
  }
  return (
    `<polyline ${dataAttrs.join(" ")} points="${pathData}" fill="none" stroke="${strokeColor}" ` +
    `stroke-width="${strokeWidth}"${dashArray}${markers} />`
  );
}
function pointsToPolylinePath(points: Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}
function renderEdgeLabel(edge: PositionedEdge): string {
  const mid = edge.labelPosition ?? edgeMidpoint(edge.points);
  const label = edge.label!;
  const padding = 8;
  const metrics = measureMultilineText(label, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel);
  const content = renderMultilineTextWithBackground(
    label,
    mid.x,
    mid.y,
    metrics.width,
    metrics.height,
    FONT_SIZES.edgeLabel,
    padding,
    `text-anchor="middle" font-size="${FONT_SIZES.edgeLabel}" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-sec)"`,
    `rx="2" ry="2" fill="var(--bg)" stroke="var(--_inner-stroke)" stroke-width="1"`,
  );
  return (
    `<g class="edge-label" data-from="${escapeAttr(edge.source)}" data-to="${escapeAttr(edge.target)}" data-label="${escapeAttr(label)}">\n` +
    `  ${content.replace(/\n/g, "\n  ")}\n` +
    `</g>`
  );
}
function edgeMidpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    totalLength += dist(points[i - 1]!, points[i]!);
  }
  let remaining = totalLength / 2;
  for (let i = 1; i < points.length; i++) {
    const segLen = dist(points[i - 1]!, points[i]!);
    if (remaining <= segLen) {
      const t = remaining / segLen;
      return {
        x: points[i - 1]!.x + t * (points[i]!.x - points[i - 1]!.x),
        y: points[i - 1]!.y + t * (points[i]!.y - points[i - 1]!.y),
      };
    }
    remaining -= segLen;
  }
  return points[points.length - 1]!;
}
function dist(a: Point, b: Point): number {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}
function renderNode(node: PositionedNode): string {
  const shape = renderNodeShape(node);
  const label = renderNodeLabel(node);
  const parts: string[] = [];
  parts.push(
    `<g class="node" data-id="${escapeAttr(node.id)}" data-label="${escapeAttr(node.label)}" data-shape="${node.shape}">`,
  );
  parts.push(`  ${shape.replace(/\n/g, "\n  ")}`);
  if (label) {
    parts.push(`  ${label.replace(/\n/g, "\n  ")}`);
  }
  parts.push("</g>");
  return parts.join("\n");
}
function renderNodeShape(node: PositionedNode): string {
  const { x, y, width, height, shape, inlineStyle } = node;
  const fill = escapeAttr(inlineStyle?.fill ?? "var(--_node-fill)");
  const stroke = escapeAttr(inlineStyle?.stroke ?? "var(--_node-stroke)");
  const sw = escapeAttr(inlineStyle?.["stroke-width"] ?? String(STROKE_WIDTHS.innerBox));
  switch (shape) {
    case "diamond":
      return renderDiamond(x, y, width, height, fill, stroke, sw);
    case "rounded":
      return renderRoundedRect(x, y, width, height, fill, stroke, sw);
    case "stadium":
      return renderStadium(x, y, width, height, fill, stroke, sw);
    case "circle":
      return renderCircle(x, y, width, height, fill, stroke, sw);
    case "subroutine":
      return renderSubroutine(x, y, width, height, fill, stroke, sw);
    case "doublecircle":
      return renderDoubleCircle(x, y, width, height, fill, stroke, sw);
    case "hexagon":
      return renderHexagon(x, y, width, height, fill, stroke, sw);
    case "cylinder":
      return renderCylinder(x, y, width, height, fill, stroke, sw);
    case "asymmetric":
      return renderAsymmetric(x, y, width, height, fill, stroke, sw);
    case "trapezoid":
      return renderTrapezoid(x, y, width, height, fill, stroke, sw);
    case "trapezoid-alt":
      return renderTrapezoidAlt(x, y, width, height, fill, stroke, sw);
    case "state-start":
      return renderStateStart(x, y, width, height);
    case "state-end":
      return renderStateEnd(x, y, width, height);
    case "rectangle":
    default:
      return renderRect(x, y, width, height, fill, stroke, sw);
  }
}
function renderRect(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="0" ry="0" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  );
}
function renderRoundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="6" ry="6" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  );
}
function renderStadium(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const r = h / 2;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="${r}" ry="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  );
}
function renderCircle(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.min(w, h) / 2;
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  );
}
function renderDiamond(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2;
  const hh = h / 2;
  const points = [
    `${cx},${cy - hh}`,
    `${cx + hw},${cy}`,
    `${cx},${cy + hh}`,
    `${cx - hw},${cy}`,
  ].join(" ");
  return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
}
function renderSubroutine(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const inset = 8;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="0" ry="0" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<line x1="${x + inset}" y1="${y}" x2="${x + inset}" y2="${y + h}" ` +
    `stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<line x1="${x + w - inset}" y1="${y}" x2="${x + w - inset}" y2="${y + h}" ` +
    `stroke="${stroke}" stroke-width="${sw}" />`
  );
}
function renderDoubleCircle(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const outerR = Math.min(w, h) / 2;
  const innerR = outerR - 5;
  return (
    `<circle cx="${cx}" cy="${cy}" r="${outerR}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<circle cx="${cx}" cy="${cy}" r="${innerR}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  );
}
function renderHexagon(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const inset = h / 4;
  const points = [
    `${x + inset},${y}`,
    `${x + w - inset},${y}`,
    `${x + w},${y + h / 2}`,
    `${x + w - inset},${y + h}`,
    `${x + inset},${y + h}`,
    `${x},${y + h / 2}`,
  ].join(" ");
  return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
}
function renderCylinder(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const ry = 7;
  const cx = x + w / 2;
  const bodyTop = y + ry;
  const bodyH = h - 2 * ry;
  return (
    `<rect x="${x}" y="${bodyTop}" width="${w}" height="${bodyH}" ` +
    `fill="${fill}" stroke="none" />` +
    `\n<line x1="${x}" y1="${bodyTop}" x2="${x}" y2="${bodyTop + bodyH}" stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<line x1="${x + w}" y1="${bodyTop}" x2="${x + w}" y2="${bodyTop + bodyH}" stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<ellipse cx="${cx}" cy="${y + h - ry}" rx="${w / 2}" ry="${ry}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<ellipse cx="${cx}" cy="${bodyTop}" rx="${w / 2}" ry="${ry}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  );
}
function renderAsymmetric(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const indent = 12;
  const points = [
    `${x + indent},${y}`,
    `${x + w},${y}`,
    `${x + w},${y + h}`,
    `${x + indent},${y + h}`,
    `${x},${y + h / 2}`,
  ].join(" ");
  return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
}
function renderTrapezoid(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const inset = w * 0.15;
  const points = [
    `${x + inset},${y}`,
    `${x + w - inset},${y}`,
    `${x + w},${y + h}`,
    `${x},${y + h}`,
  ].join(" ");
  return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
}
function renderTrapezoidAlt(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  sw: string,
): string {
  const inset = w * 0.15;
  const points = [
    `${x},${y}`,
    `${x + w},${y}`,
    `${x + w - inset},${y + h}`,
    `${x + inset},${y + h}`,
  ].join(" ");
  return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
}
function renderStateStart(x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.min(w, h) / 2 - 2;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--_text)" stroke="none" />`;
}
function renderStateEnd(x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const outerR = Math.min(w, h) / 2 - 2;
  const innerR = outerR - 4;
  return (
    `<circle cx="${cx}" cy="${cy}" r="${outerR}" ` +
    `fill="none" stroke="var(--_text)" stroke-width="${STROKE_WIDTHS.innerBox * 2}" />` +
    `\n<circle cx="${cx}" cy="${cy}" r="${innerR}" fill="var(--_text)" stroke="none" />`
  );
}
function renderNodeLabel(node: PositionedNode): string {
  if (node.shape === "state-start" || node.shape === "state-end") {
    if (!node.label) return "";
  }
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const textColor = escapeAttr(node.inlineStyle?.color ?? "var(--_text)");
  return renderMultilineText(
    node.label,
    cx,
    cy,
    FONT_SIZES.nodeLabel,
    `text-anchor="middle" font-size="${FONT_SIZES.nodeLabel}" font-weight="${FONT_WEIGHTS.nodeLabel}" fill="${textColor}"`,
  );
}
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
