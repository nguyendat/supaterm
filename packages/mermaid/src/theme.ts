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
const MIX = {
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
    --_text:          var(--diagram-fg);
    --_text-sec:      var(--diagram-muted, color-mix(in srgb, var(--diagram-fg) ${MIX.textSec}%, var(--diagram-bg)));
    --_text-muted:    var(--diagram-muted, color-mix(in srgb, var(--diagram-fg) ${MIX.textMuted}%, var(--diagram-bg)));
    --_text-faint:    color-mix(in srgb, var(--diagram-fg) ${MIX.textFaint}%, var(--diagram-bg));
    --_line:          var(--diagram-line, color-mix(in srgb, var(--diagram-fg) ${MIX.line}%, var(--diagram-bg)));
    --_arrow:         var(--diagram-accent, color-mix(in srgb, var(--diagram-fg) ${MIX.arrow}%, var(--diagram-bg)));
    --_node-fill:     var(--diagram-surface, color-mix(in srgb, var(--diagram-fg) ${MIX.nodeFill}%, var(--diagram-bg)));
    --_node-stroke:   var(--diagram-border, color-mix(in srgb, var(--diagram-fg) ${MIX.nodeStroke}%, var(--diagram-bg)));
    --_group-fill:    var(--diagram-bg);
    --_group-hdr:     color-mix(in srgb, var(--diagram-fg) ${MIX.groupHeader}%, var(--diagram-bg));
    --_inner-stroke:  color-mix(in srgb, var(--diagram-fg) ${MIX.innerStroke}%, var(--diagram-bg));
    --_key-badge:     color-mix(in srgb, var(--diagram-fg) ${MIX.keyBadge}%, var(--diagram-bg));`;
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
  const vars = [
    `--diagram-bg:${colors.bg}`,
    `--diagram-fg:${colors.fg}`,
    colors.line ? `--diagram-line:${colors.line}` : "",
    colors.accent ? `--diagram-accent:${colors.accent}` : "",
    colors.muted ? `--diagram-muted:${colors.muted}` : "",
    colors.surface ? `--diagram-surface:${colors.surface}` : "",
    colors.border ? `--diagram-border:${colors.border}` : "",
  ]
    .filter(Boolean)
    .join(";");
  const bgStyle = transparent ? "" : ";background:var(--diagram-bg)";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" style="${vars}${bgStyle}">`
  );
}
