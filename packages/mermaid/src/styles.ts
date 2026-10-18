import { measureTextWidth } from "./text-metrics.ts";
export function estimateTextWidth(text: string, fontSize: number, fontWeight: number): number {
  return measureTextWidth(text, fontSize, fontWeight);
}
export function estimateMonoTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}
export const MONO_FONT = "var(--font-mono, ui-monospace, monospace)";
export const FONT_SIZES = {
  nodeLabel: 13,
  edgeLabel: 11,
  groupHeader: 12,
} as const;
export const FONT_WEIGHTS = {
  nodeLabel: 500,
  edgeLabel: 400,
  groupHeader: 600,
} as const;
export const NODE_PADDING = {
  horizontal: 20,
  vertical: 10,
  diamondExtra: 24,
} as const;
export const STROKE_WIDTHS = {
  outerBox: 1,
  innerBox: 0.75,
  connector: 1,
} as const;
export const SEQUENCE_ACTOR_NAME_OFFSET = 14;
export const TEXT_BASELINE_SHIFT = "0.35em" as const;
export const ARROW_HEAD = {
  width: 8,
  height: 5,
} as const;
