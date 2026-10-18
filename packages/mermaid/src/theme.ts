import { MONO_FONT } from "./styles.ts";
export interface DiagramColors {
  bg: string;
  fg: string;
  line?: string;
  accent?: string;
  muted?: string;
  surface?: string;
  border?: string;
}
export const MIX = {
  text: 100,
  textSec: 60,
  textMuted: 40,
  textFaint: 25,
  line: 50,
  arrow: 85,
  nodeFill: 3,
  nodeStroke: 20,
  groupHeader: 5,
  innerStroke: 12,
  keyBadge: 10,
} as const;
export function buildStyleBlock(font: string, hasMonoFont: boolean): string {
  const derivedVars = `
    --_text:          var(--fg);
    --_text-sec:      var(--muted, color-mix(in srgb, var(--fg) ${MIX.textSec}%, var(--bg)));
    --_text-muted:    var(--muted, color-mix(in srgb, var(--fg) ${MIX.textMuted}%, var(--bg)));
    --_text-faint:    color-mix(in srgb, var(--fg) ${MIX.textFaint}%, var(--bg));
    --_line:          var(--line, color-mix(in srgb, var(--fg) ${MIX.line}%, var(--bg)));
    --_arrow:         var(--accent, color-mix(in srgb, var(--fg) ${MIX.arrow}%, var(--bg)));
    --_node-fill:     var(--surface, color-mix(in srgb, var(--fg) ${MIX.nodeFill}%, var(--bg)));
    --_node-stroke:   var(--border, color-mix(in srgb, var(--fg) ${MIX.nodeStroke}%, var(--bg)));
    --_group-fill:    var(--bg);
    --_group-hdr:     color-mix(in srgb, var(--fg) ${MIX.groupHeader}%, var(--bg));
    --_inner-stroke:  color-mix(in srgb, var(--fg) ${MIX.innerStroke}%, var(--bg));
    --_key-badge:     color-mix(in srgb, var(--fg) ${MIX.keyBadge}%, var(--bg));`;
  return [
    "<style>",
    `  text { font-family: ${font}; }`,
    ...(hasMonoFont ? [`  .mono { font-family: ${MONO_FONT}; }`] : []),
    `  svg {${derivedVars}`,
    `  }`,
    "</style>",
  ].join("\n");
}
export function svgOpenTag(
  width: number,
  height: number,
  colors: DiagramColors,
  transparent?: boolean,
): string {
  // Unset enrichment variables reset to initial so same-named variables inherited from the
  // host page cannot replace their color-mix() fallbacks.
  const vars = [
    `--bg:${colors.bg}`,
    `--fg:${colors.fg}`,
    `--line:${colors.line ?? "initial"}`,
    `--accent:${colors.accent ?? "initial"}`,
    `--muted:${colors.muted ?? "initial"}`,
    `--surface:${colors.surface ?? "initial"}`,
    `--border:${colors.border ?? "initial"}`,
  ].join(";");
  const bgStyle = transparent ? "" : ";background:var(--bg)";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" style="${vars}${bgStyle}">`
  );
}
