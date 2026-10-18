const NARROW_CHARS = new Set([
  "i",
  "l",
  "t",
  "f",
  "j",
  "I",
  "1",
  "!",
  "|",
  ".",
  ",",
  ":",
  ";",
  "'",
]);
const WIDE_CHARS = new Set(["W", "M", "w", "m", "@", "%"]);
const VERY_WIDE_CHARS = new Set(["W", "M"]);
const SEMI_NARROW_PUNCT = new Set(["(", ")", "[", "]", "{", "}", "/", "\\", "-", '"', "`"]);
function isCombiningMark(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}
function isFullwidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x2eff) ||
    (code >= 0x2f00 && code <= 0x2fdf) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x309f) ||
    (code >= 0x30a0 && code <= 0x30ff) ||
    (code >= 0x3100 && code <= 0x312f) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x3190 && code <= 0x31ff) ||
    (code >= 0x3200 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x20000
  );
}
const EMOJI_REGEX = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u;
function isEmoji(char: string): boolean {
  return EMOJI_REGEX.test(char);
}
export function getCharWidth(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined) return 0;
  if (isCombiningMark(code)) return 0;
  if (isFullwidth(code) || isEmoji(char)) return 2.0;
  if (char === " ") return 0.3;
  if (VERY_WIDE_CHARS.has(char)) return 1.5;
  if (WIDE_CHARS.has(char)) return 1.2;
  if (NARROW_CHARS.has(char)) return 0.4;
  if (SEMI_NARROW_PUNCT.has(char)) return 0.5;
  if (char === "r") return 0.8;
  if (code >= 65 && code <= 90) return 1.2;
  if (code >= 48 && code <= 57) return 1.0;
  return 1.0;
}
export function measureTextWidth(text: string, fontSize: number, fontWeight: number): number {
  const baseRatio = fontWeight >= 600 ? 0.6 : fontWeight >= 500 ? 0.57 : 0.54;
  let totalWidth = 0;
  for (const char of text) {
    totalWidth += getCharWidth(char);
  }
  const minPadding = fontSize * 0.15;
  return totalWidth * fontSize * baseRatio + minPadding;
}
export const LINE_HEIGHT_RATIO = 1.3;
export interface MultilineMetrics {
  width: number;
  height: number;
  lines: string[];
  lineHeight: number;
}
export function measureMultilineText(
  text: string,
  fontSize: number,
  fontWeight: number,
): MultilineMetrics {
  const lines = text.split("\n");
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  let maxWidth = 0;
  for (const line of lines) {
    const plain = line.replace(/<\/?(?:b|strong|i|em|u|s|del)\s*>/gi, "");
    const w = measureTextWidth(plain, fontSize, fontWeight);
    if (w > maxWidth) maxWidth = w;
  }
  return {
    width: maxWidth,
    height: lines.length * lineHeight,
    lines,
    lineHeight,
  };
}
