import type {
  PositionedClassDiagram,
  PositionedClassNode,
  PositionedClassRelationship,
  ClassMember,
  RelationshipType,
} from "./types.ts";
import type { DiagramColors } from "../theme.ts";
import { svgOpenTag, buildStyleBlock } from "../theme.ts";
import { FONT_SIZES, FONT_WEIGHTS, STROKE_WIDTHS, TEXT_BASELINE_SHIFT } from "../styles.ts";
import { CLS } from "./layout.ts";
import { renderMultilineText, escapeXml } from "../multiline-utils.ts";
const CLS_FONT = {
  memberSize: 11,
  memberWeight: 400,
  annotationSize: 10,
  annotationWeight: 500,
} as const;
export function renderClassSvg(
  diagram: PositionedClassDiagram,
  colors: DiagramColors,
  font: string,
  transparent: boolean = false,
): string {
  const parts: string[] = [];
  parts.push(svgOpenTag(diagram.width, diagram.height, colors, transparent));
  parts.push(buildStyleBlock(font, true));
  parts.push("<defs>");
  parts.push(relationshipMarkerDefs());
  parts.push("</defs>");
  for (const rel of diagram.relationships) {
    parts.push(renderRelationship(rel));
  }
  for (const cls of diagram.classes) {
    parts.push(renderClassBox(cls));
  }
  for (const rel of diagram.relationships) {
    parts.push(renderRelationshipLabels(rel));
  }
  parts.push("</svg>");
  return parts.join("\n");
}
function relationshipMarkerDefs(): string {
  return (
    `  <marker id="cls-inherit" markerWidth="12" markerHeight="10" refX="12" refY="5" orient="auto-start-reverse">` +
    `\n    <polygon points="0 0, 12 5, 0 10" fill="var(--diagram-bg)" stroke="var(--_arrow)" stroke-width="1.5" />` +
    `\n  </marker>` +
    `\n  <marker id="cls-composition" markerWidth="12" markerHeight="10" refX="0" refY="5" orient="auto-start-reverse">` +
    `\n    <polygon points="6 0, 12 5, 6 10, 0 5" fill="var(--_arrow)" stroke="var(--_arrow)" stroke-width="1" />` +
    `\n  </marker>` +
    `\n  <marker id="cls-aggregation" markerWidth="12" markerHeight="10" refX="0" refY="5" orient="auto-start-reverse">` +
    `\n    <polygon points="6 0, 12 5, 6 10, 0 5" fill="var(--diagram-bg)" stroke="var(--_arrow)" stroke-width="1.5" />` +
    `\n  </marker>` +
    `\n  <marker id="cls-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto-start-reverse">` +
    `\n    <polyline points="0 0, 8 3, 0 6" fill="none" stroke="var(--_arrow)" stroke-width="1.5" />` +
    `\n  </marker>`
  );
}
function renderClassBox(cls: PositionedClassNode): string {
  const { x, y, width, height, headerHeight, attrHeight } = cls;
  const parts: string[] = [];
  const annotationAttr = cls.annotation ? ` data-annotation="${escapeAttr(cls.annotation)}"` : "";
  parts.push(
    `<g class="class-node" data-id="${escapeAttr(cls.id)}" data-label="${escapeAttr(cls.label)}"${annotationAttr}>`,
  );
  parts.push(
    `  <rect x="${x}" y="${y}" width="${width}" height="${height}" ` +
      `rx="0" ry="0" fill="var(--_node-fill)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
  );
  parts.push(
    `  <rect x="${x}" y="${y}" width="${width}" height="${headerHeight}" ` +
      `rx="0" ry="0" fill="var(--_group-hdr)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
  );
  let nameY = y + headerHeight / 2;
  if (cls.annotation) {
    const annotY = y + 12;
    parts.push(
      `  <text x="${x + width / 2}" y="${annotY}" text-anchor="middle" dy="${TEXT_BASELINE_SHIFT}" ` +
        `font-size="${CLS_FONT.annotationSize}" font-weight="${CLS_FONT.annotationWeight}" ` +
        `font-style="italic" fill="var(--_text-muted)">&lt;&lt;${escapeXml(cls.annotation)}&gt;&gt;</text>`,
    );
    nameY = y + headerHeight / 2 + 6;
  }
  parts.push(
    "  " +
      renderMultilineText(
        cls.label,
        x + width / 2,
        nameY,
        FONT_SIZES.nodeLabel,
        `text-anchor="middle" font-size="${FONT_SIZES.nodeLabel}" font-weight="700" fill="var(--_text)"`,
      ),
  );
  const attrTop = y + headerHeight;
  parts.push(
    `  <line x1="${x}" y1="${attrTop}" x2="${x + width}" y2="${attrTop}" ` +
      `stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.innerBox}" />`,
  );
  const memberRowH = 20;
  for (let i = 0; i < cls.attributes.length; i++) {
    const member = cls.attributes[i]!;
    const memberY = attrTop + 4 + i * memberRowH + memberRowH / 2;
    parts.push("  " + renderMember(member, x + CLS.boxPadX, memberY));
  }
  const methodTop = attrTop + attrHeight;
  parts.push(
    `  <line x1="${x}" y1="${methodTop}" x2="${x + width}" y2="${methodTop}" ` +
      `stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.innerBox}" />`,
  );
  for (let i = 0; i < cls.methods.length; i++) {
    const member = cls.methods[i]!;
    const memberY = methodTop + 4 + i * memberRowH + memberRowH / 2;
    parts.push("  " + renderMember(member, x + CLS.boxPadX, memberY));
  }
  parts.push("</g>");
  return parts.join("\n");
}
function renderMember(member: ClassMember, x: number, y: number): string {
  const fontStyle = member.isAbstract ? ' font-style="italic"' : "";
  const decoration = member.isStatic ? ' text-decoration="underline"' : "";
  const spans: string[] = [];
  if (member.visibility) {
    spans.push(`<tspan fill="var(--_text-faint)">${escapeXml(member.visibility)} </tspan>`);
  }
  const displayName = member.isMethod ? `${member.name}(${member.params || ""})` : member.name;
  spans.push(`<tspan fill="var(--_text-sec)">${escapeXml(displayName)}</tspan>`);
  if (member.type) {
    spans.push(`<tspan fill="var(--_text-faint)">: </tspan>`);
    spans.push(`<tspan fill="var(--_text-muted)">${escapeXml(member.type)}</tspan>`);
  }
  return (
    `<text x="${x}" y="${y}" class="mono" dy="${TEXT_BASELINE_SHIFT}" ` +
    `font-size="${CLS_FONT.memberSize}" font-weight="${CLS_FONT.memberWeight}"${fontStyle}${decoration}>` +
    `${spans.join("")}</text>`
  );
}
function renderRelationship(rel: PositionedClassRelationship): string {
  if (rel.points.length < 2) return "";
  const pathData = rel.points.map((p) => `${p.x},${p.y}`).join(" ");
  const isDashed = rel.type === "dependency" || rel.type === "realization";
  const dashArray = isDashed ? ' stroke-dasharray="6 4"' : "";
  const markers = getRelationshipMarkers(rel.type, rel.markerAt);
  const dataAttrs = [
    'class="class-relationship"',
    `data-from="${escapeAttr(rel.from)}"`,
    `data-to="${escapeAttr(rel.to)}"`,
    `data-type="${rel.type}"`,
    `data-marker-at="${rel.markerAt}"`,
  ];
  if (rel.label) {
    dataAttrs.push(`data-label="${escapeAttr(rel.label)}"`);
  }
  if (rel.fromCardinality) {
    dataAttrs.push(`data-from-cardinality="${escapeAttr(rel.fromCardinality)}"`);
  }
  if (rel.toCardinality) {
    dataAttrs.push(`data-to-cardinality="${escapeAttr(rel.toCardinality)}"`);
  }
  return (
    `<polyline ${dataAttrs.join(" ")} points="${pathData}" fill="none" stroke="var(--_line)" ` +
    `stroke-width="${STROKE_WIDTHS.connector}"${dashArray}${markers} />`
  );
}
function getRelationshipMarkers(type: RelationshipType, markerAt: "from" | "to"): string {
  const markerId = getMarkerDefId(type);
  if (!markerId) return "";
  if (markerAt === "from") {
    return ` marker-start="url(#${markerId})"`;
  } else {
    return ` marker-end="url(#${markerId})"`;
  }
}
function getMarkerDefId(type: RelationshipType): string | null {
  switch (type) {
    case "inheritance":
    case "realization":
      return "cls-inherit";
    case "composition":
      return "cls-composition";
    case "aggregation":
      return "cls-aggregation";
    case "association":
    case "dependency":
      return "cls-arrow";
    default:
      return null;
  }
}
function renderRelationshipLabels(rel: PositionedClassRelationship): string {
  if (!rel.label && !rel.fromCardinality && !rel.toCardinality) return "";
  if (rel.points.length < 2) return "";
  const parts: string[] = [];
  if (rel.label) {
    const pos = rel.labelPosition ?? midpoint(rel.points);
    parts.push(
      renderMultilineText(
        rel.label,
        pos.x,
        pos.y - 8,
        FONT_SIZES.edgeLabel,
        `font-size="${FONT_SIZES.edgeLabel}" text-anchor="middle" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-muted)"`,
      ),
    );
  }
  if (rel.fromCardinality) {
    const p = rel.points[0]!;
    const next = rel.points[1]!;
    const offset = cardinalityOffset(p, next);
    parts.push(
      renderMultilineText(
        rel.fromCardinality,
        p.x + offset.x,
        p.y + offset.y,
        FONT_SIZES.edgeLabel,
        `font-size="${FONT_SIZES.edgeLabel}" text-anchor="middle" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-muted)"`,
      ),
    );
  }
  if (rel.toCardinality) {
    const p = rel.points[rel.points.length - 1]!;
    const prev = rel.points[rel.points.length - 2]!;
    const offset = cardinalityOffset(p, prev);
    parts.push(
      renderMultilineText(
        rel.toCardinality,
        p.x + offset.x,
        p.y + offset.y,
        FONT_SIZES.edgeLabel,
        `font-size="${FONT_SIZES.edgeLabel}" text-anchor="middle" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-muted)"`,
      ),
    );
  }
  return parts.join("\n");
}
function midpoint(
  points: Array<{
    x: number;
    y: number;
  }>,
): {
  x: number;
  y: number;
} {
  if (points.length === 0) return { x: 0, y: 0 };
  const mid = Math.floor(points.length / 2);
  return points[mid]!;
}
function cardinalityOffset(
  from: {
    x: number;
    y: number;
  },
  to: {
    x: number;
    y: number;
  },
): {
  x: number;
  y: number;
} {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: dx > 0 ? 14 : -14, y: -10 };
  }
  return { x: -14, y: dy > 0 ? 14 : -14 };
}
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
