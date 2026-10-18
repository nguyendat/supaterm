import { LINE_HEIGHT_RATIO } from "./text-metrics.ts";
export function normalizeBrTags(label: string): string {
  const unquoted = label.startsWith('"') && label.endsWith('"') ? label.slice(1, -1) : label;
  return unquoted
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\n/g, "\n")
    .replace(/<\/?(?:sub|sup|small|mark)\s*>/gi, "")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\*)\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/g, "<i>$1</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>");
}
export function stripFormattingTags(text: string): string {
  return text.replace(/<\/?(?:b|strong|i|em|u|s|del)\s*>/gi, "");
}
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
interface StyledSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}
const FORMAT_TAG_REGEX = /<(\/)?(?:(b|strong)|(i|em)|(u)|(s|del))\s*>/gi;
function parseInlineFormatting(line: string): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let bold = false,
    italic = false,
    underline = false,
    strikethrough = false;
  let lastIndex = 0;
  FORMAT_TAG_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FORMAT_TAG_REGEX.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        text: line.slice(lastIndex, match.index),
        bold,
        italic,
        underline,
        strikethrough,
      });
    }
    lastIndex = match.index + match[0].length;
    const isClosing = Boolean(match[1]);
    if (match[2]) bold = !isClosing;
    else if (match[3]) italic = !isClosing;
    else if (match[4]) underline = !isClosing;
    else if (match[5]) strikethrough = !isClosing;
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), bold, italic, underline, strikethrough });
  }
  return segments;
}
const HAS_FORMAT_TAGS = /<\/?(?:b|strong|i|em|u|s|del)\s*>/i;
function renderLineContent(line: string): string {
  if (!HAS_FORMAT_TAGS.test(line)) return escapeXml(line);
  const segments = parseInlineFormatting(line);
  if (segments.length === 0) return "";
  const allPlain = segments.every((s) => !s.bold && !s.italic && !s.underline && !s.strikethrough);
  if (allPlain) return segments.map((s) => escapeXml(s.text)).join("");
  return segments
    .map((seg) => {
      const escaped = escapeXml(seg.text);
      if (!seg.bold && !seg.italic && !seg.underline && !seg.strikethrough) return escaped;
      const attrs: string[] = [];
      if (seg.bold) attrs.push('font-weight="bold"');
      if (seg.italic) attrs.push('font-style="italic"');
      const deco: string[] = [];
      if (seg.underline) deco.push("underline");
      if (seg.strikethrough) deco.push("line-through");
      if (deco.length) attrs.push(`text-decoration="${deco.join(" ")}"`);
      return `<tspan ${attrs.join(" ")}>${escaped}</tspan>`;
    })
    .join("");
}
export function renderMultilineText(
  text: string,
  cx: number,
  cy: number,
  fontSize: number,
  attrs: string,
  baselineShift: number = 0.35,
): string {
  const lines = text.split("\n");
  if (lines.length === 1) {
    const dy = fontSize * baselineShift;
    return `<text x="${cx}" y="${cy}" ${attrs} dy="${dy}">${renderLineContent(text)}</text>`;
  }
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const firstDy = -((lines.length - 1) / 2) * lineHeight + fontSize * baselineShift;
  const tspans = lines
    .map((line, i) => {
      const dy = i === 0 ? firstDy : lineHeight;
      return `<tspan x="${cx}" dy="${dy}">${renderLineContent(line)}</tspan>`;
    })
    .join("");
  return `<text x="${cx}" y="${cy}" ${attrs}>${tspans}</text>`;
}
export function renderMultilineTextWithBackground(
  text: string,
  cx: number,
  cy: number,
  textWidth: number,
  textHeight: number,
  fontSize: number,
  padding: number,
  textAttrs: string,
  bgAttrs: string,
): string {
  const bgWidth = textWidth + padding * 2;
  const bgHeight = textHeight + padding * 2;
  const rect =
    `<rect x="${cx - bgWidth / 2}" y="${cy - bgHeight / 2}" ` +
    `width="${bgWidth}" height="${bgHeight}" ${bgAttrs} />`;
  const textEl = renderMultilineText(text, cx, cy, fontSize, textAttrs);
  return `${rect}\n${textEl}`;
}
