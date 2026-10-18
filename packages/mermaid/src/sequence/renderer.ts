import type {
  PositionedSequenceDiagram,
  PositionedActor,
  Lifeline,
  PositionedMessage,
  Activation,
  PositionedBlock,
  PositionedNote,
} from "./types.ts";
import type { DiagramColors } from "../theme.ts";
import { svgOpenTag, buildStyleBlock } from "../theme.ts";
import {
  FONT_SIZES,
  FONT_WEIGHTS,
  STROKE_WIDTHS,
  ARROW_HEAD,
  estimateTextWidth,
} from "../styles.ts";
import { renderMultilineText } from "../multiline-utils.ts";
export function renderSequenceSvg(
  diagram: PositionedSequenceDiagram,
  colors: DiagramColors,
  font: string,
  transparent: boolean = false,
): string {
  const parts: string[] = [];
  parts.push(svgOpenTag(diagram.width, diagram.height, colors, transparent));
  parts.push(buildStyleBlock(font, false));
  parts.push("<defs>");
  parts.push(arrowMarkerDefs());
  parts.push("</defs>");
  for (const block of diagram.blocks) {
    parts.push(renderBlock(block));
  }
  for (const lifeline of diagram.lifelines) {
    parts.push(renderLifeline(lifeline));
  }
  for (const activation of diagram.activations) {
    parts.push(renderActivation(activation));
  }
  for (const message of diagram.messages) {
    parts.push(renderMessage(message));
  }
  for (const note of diagram.notes) {
    parts.push(renderNote(note));
  }
  for (const actor of diagram.actors) {
    parts.push(renderActor(actor));
  }
  parts.push("</svg>");
  return parts.join("\n");
}
function arrowMarkerDefs(): string {
  const w = ARROW_HEAD.width;
  const h = ARROW_HEAD.height;
  return (
    `  <marker id="seq-arrow" markerWidth="${w}" markerHeight="${h}" refX="${w}" refY="${h / 2}" orient="auto-start-reverse">` +
    `\n    <polygon points="0 0, ${w} ${h / 2}, 0 ${h}" fill="var(--_arrow)" />` +
    `\n  </marker>` +
    `\n  <marker id="seq-arrow-open" markerWidth="${w}" markerHeight="${h}" refX="${w}" refY="${h / 2}" orient="auto-start-reverse">` +
    `\n    <polyline points="0 0, ${w} ${h / 2}, 0 ${h}" fill="none" stroke="var(--_arrow)" stroke-width="1" />` +
    `\n  </marker>`
  );
}
function renderActor(actor: PositionedActor): string {
  const { id, x, y, width, height, label, type } = actor;
  const parts: string[] = [];
  parts.push(
    `<g class="actor" data-id="${escapeAttr(id)}" data-label="${escapeAttr(label)}" data-type="${type}">`,
  );
  if (type === "actor") {
    const s = (height / 24) * 0.9;
    const tx = x - 12 * s;
    const ty = y + (height - 24 * s) / 2;
    const sw = STROKE_WIDTHS.outerBox / s;
    const iconStroke = "var(--_line)";
    parts.push(
      `  <g transform="translate(${tx},${ty}) scale(${s})">` +
        `\n    <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" fill="none" stroke="${iconStroke}" stroke-width="${sw}" />` +
        `\n    <path d="M15 10C15 11.6569 13.6569 13 12 13C10.3431 13 9 11.6569 9 10C9 8.34315 10.3431 7 12 7C13.6569 7 15 8.34315 15 10Z" fill="none" stroke="${iconStroke}" stroke-width="${sw}" />` +
        `\n    <path d="M5.62842 18.3563C7.08963 17.0398 9.39997 16 12 16C14.6 16 16.9104 17.0398 18.3716 18.3563" fill="none" stroke="${iconStroke}" stroke-width="${sw}" />` +
        `\n  </g>`,
    );
    parts.push(
      "  " +
        renderMultilineText(
          label,
          x,
          y + height + 14,
          FONT_SIZES.nodeLabel,
          `font-size="${FONT_SIZES.nodeLabel}" text-anchor="middle" font-weight="${FONT_WEIGHTS.nodeLabel}" fill="var(--_text)"`,
        ),
    );
  } else {
    const boxX = x - width / 2;
    parts.push(
      `  <rect x="${boxX}" y="${y}" width="${width}" height="${height}" rx="4" ry="4" ` +
        `fill="var(--_node-fill)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
    );
    parts.push(
      "  " +
        renderMultilineText(
          label,
          x,
          y + height / 2,
          FONT_SIZES.nodeLabel,
          `font-size="${FONT_SIZES.nodeLabel}" text-anchor="middle" font-weight="${FONT_WEIGHTS.nodeLabel}" fill="var(--_text)"`,
        ),
    );
  }
  parts.push("</g>");
  return parts.join("\n");
}
function renderLifeline(lifeline: Lifeline): string {
  return (
    `<line class="lifeline" data-actor="${escapeAttr(lifeline.actorId)}" ` +
    `x1="${lifeline.x}" y1="${lifeline.topY}" x2="${lifeline.x}" y2="${lifeline.bottomY}" ` +
    `stroke="var(--_line)" stroke-width="0.75" stroke-dasharray="6 4" />`
  );
}
function renderActivation(activation: Activation): string {
  return (
    `<rect class="activation" data-actor="${escapeAttr(activation.actorId)}" ` +
    `x="${activation.x}" y="${activation.topY}" width="${activation.width}" height="${activation.bottomY - activation.topY}" ` +
    `fill="var(--_node-fill)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.innerBox}" />`
  );
}
function renderMessage(msg: PositionedMessage): string {
  const parts: string[] = [];
  const dashArray = msg.lineStyle === "dashed" ? ' stroke-dasharray="6 4"' : "";
  const markerId = msg.arrowHead === "filled" ? "seq-arrow" : "seq-arrow-open";
  parts.push(
    `<g class="message" data-from="${escapeAttr(msg.from)}" data-to="${escapeAttr(msg.to)}" ` +
      `data-label="${escapeAttr(msg.label)}" data-line-style="${msg.lineStyle}" ` +
      `data-arrow-head="${msg.arrowHead}" data-self="${msg.isSelf}">`,
  );
  if (msg.isSelf) {
    const loopW = 30;
    const loopH = 20;
    const labelPadding = 8;
    parts.push(
      `  <polyline points="${msg.x1},${msg.y} ${msg.x1 + loopW},${msg.y} ${msg.x1 + loopW},${msg.y + loopH} ${msg.x2},${msg.y + loopH}" ` +
        `fill="none" stroke="var(--_line)" stroke-width="${STROKE_WIDTHS.connector}"${dashArray} marker-end="url(#${markerId})" />`,
    );
    parts.push(
      "  " +
        renderMultilineText(
          msg.label,
          msg.x1 + loopW + labelPadding,
          msg.y + loopH / 2,
          FONT_SIZES.edgeLabel,
          `font-size="${FONT_SIZES.edgeLabel}" text-anchor="start" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-muted)"`,
        ),
    );
  } else {
    parts.push(
      `  <line x1="${msg.x1}" y1="${msg.y}" x2="${msg.x2}" y2="${msg.y}" ` +
        `stroke="var(--_line)" stroke-width="${STROKE_WIDTHS.connector}"${dashArray} marker-end="url(#${markerId})" />`,
    );
    const midX = (msg.x1 + msg.x2) / 2;
    parts.push(
      "  " +
        renderMultilineText(
          msg.label,
          midX,
          msg.y - 10,
          FONT_SIZES.edgeLabel,
          `font-size="${FONT_SIZES.edgeLabel}" text-anchor="middle" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-muted)"`,
        ),
    );
  }
  parts.push("</g>");
  return parts.join("\n");
}
function renderBlock(block: PositionedBlock): string {
  const parts: string[] = [];
  const labelAttr = block.label ? ` data-label="${escapeAttr(block.label)}"` : "";
  parts.push(`<g class="block" data-type="${escapeAttr(block.type)}"${labelAttr}>`);
  parts.push(
    `  <rect x="${block.x}" y="${block.y}" width="${block.width}" height="${block.height}" ` +
      `rx="0" ry="0" fill="none" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
  );
  const labelText = `${block.type}${block.label ? ` [${block.label}]` : ""}`;
  const firstLine = labelText.split("\n")[0]!;
  const tabWidth =
    estimateTextWidth(firstLine, FONT_SIZES.edgeLabel, FONT_WEIGHTS.groupHeader) + 16;
  const tabHeight = 18;
  parts.push(
    `  <rect x="${block.x}" y="${block.y}" width="${tabWidth}" height="${tabHeight}" ` +
      `fill="var(--_group-hdr)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
  );
  parts.push(
    "  " +
      renderMultilineText(
        labelText,
        block.x + 6,
        block.y + tabHeight / 2,
        FONT_SIZES.edgeLabel,
        `font-size="${FONT_SIZES.edgeLabel}" font-weight="${FONT_WEIGHTS.groupHeader}" fill="var(--_text-sec)"`,
      ),
  );
  for (const divider of block.dividers) {
    parts.push(
      `  <line x1="${block.x}" y1="${divider.y}" x2="${block.x + block.width}" y2="${divider.y}" ` +
        `stroke="var(--_line)" stroke-width="0.75" stroke-dasharray="6 4" />`,
    );
    if (divider.label) {
      parts.push(
        "  " +
          renderMultilineText(
            `[${divider.label}]`,
            block.x + 8,
            divider.y + 14,
            FONT_SIZES.edgeLabel,
            `font-size="${FONT_SIZES.edgeLabel}" text-anchor="start" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-muted)"`,
          ),
      );
    }
  }
  parts.push("</g>");
  return parts.join("\n");
}
function renderNote(note: PositionedNote): string {
  const foldSize = 6;
  const { x, y, width: w, height: h } = note;
  const actorsAttr =
    note.actors && note.actors.length > 0
      ? ` data-actors="${note.actors.map(escapeAttr).join(",")}"`
      : "";
  const positionAttr = note.position ? ` data-position="${escapeAttr(note.position)}"` : "";
  const bodyPoints = [
    `${x},${y}`,
    `${x + w - foldSize},${y}`,
    `${x + w},${y + foldSize}`,
    `${x + w},${y + h}`,
    `${x},${y + h}`,
  ].join(" ");
  return (
    `<g class="note"${positionAttr}${actorsAttr}>` +
    `\n  <polygon points="${bodyPoints}" ` +
    `fill="var(--diagram-bg)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.innerBox}" />` +
    `\n  <polygon points="${x + w - foldSize},${y} ${x + w},${y + foldSize} ${x + w - foldSize},${y + foldSize}" ` +
    `fill="var(--_inner-stroke)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.innerBox}" />` +
    `\n  ${renderMultilineText(note.text, x + w / 2, y + h / 2, FONT_SIZES.edgeLabel, `font-size="${FONT_SIZES.edgeLabel}" text-anchor="middle" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-muted)"`)}` +
    `\n</g>`
  );
}
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
