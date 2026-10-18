import { validateCanvas, type RenderBudget } from "../budget.ts";
import type { Canvas, DrawingCoord } from "./types.ts";
export function mkCanvas(x: number, y: number, budget?: RenderBudget): Canvas {
  validateCanvas(x + 1, y + 1);
  budget?.allocate(x + 1, y + 1);
  const canvas: Canvas = [];
  canvas.budget = budget;
  for (let i = 0; i <= x; i++) {
    const col: string[] = [];
    for (let j = 0; j <= y; j++) {
      col.push(" ");
    }
    canvas.push(col);
  }
  return canvas;
}
export function copyCanvas(source: Canvas): Canvas {
  const [maxX, maxY] = getCanvasSize(source);
  return mkCanvas(maxX, maxY, source.budget);
}
export function getCanvasSize(canvas: Canvas): [number, number] {
  return [canvas.length - 1, (canvas[0]?.length ?? 1) - 1];
}
export function increaseSize(canvas: Canvas, newX: number, newY: number): Canvas {
  const [currX, currY] = getCanvasSize(canvas);
  const targetX = Math.max(newX, currX);
  const targetY = Math.max(newY, currY);
  if (targetX === currX && targetY === currY) return canvas;
  const grown = mkCanvas(targetX, targetY, canvas.budget);
  for (let x = 0; x < grown.length; x++) {
    for (let y = 0; y < grown[0]!.length; y++) {
      if (x < canvas.length && y < canvas[0]!.length) {
        grown[x]![y] = canvas[x]![y]!;
      }
    }
  }
  canvas.length = 0;
  canvas.push(...grown);
  return canvas;
}
const JUNCTION_CHARS = new Set([
  "─",
  "│",
  "┌",
  "┐",
  "└",
  "┘",
  "├",
  "┤",
  "┬",
  "┴",
  "┼",
  "╴",
  "╵",
  "╶",
  "╷",
]);
export function isJunctionChar(c: string): boolean {
  return JUNCTION_CHARS.has(c);
}
function isAlphanumeric(c: string): boolean {
  return /^[a-zA-Z0-9]$/.test(c);
}
const JUNCTION_MAP: Record<string, Record<string, string>> = {
  "─": { "│": "┼", "┌": "┬", "┐": "┬", "└": "┴", "┘": "┴", "├": "┼", "┤": "┼", "┬": "┬", "┴": "┴" },
  "│": { "─": "┼", "┌": "├", "┐": "┤", "└": "├", "┘": "┤", "├": "├", "┤": "┤", "┬": "┼", "┴": "┼" },
  "┌": { "─": "┬", "│": "├", "┐": "┬", "└": "├", "┘": "┼", "├": "├", "┤": "┼", "┬": "┬", "┴": "┼" },
  "┐": { "─": "┬", "│": "┤", "┌": "┬", "└": "┼", "┘": "┤", "├": "┼", "┤": "┤", "┬": "┬", "┴": "┼" },
  "└": { "─": "┴", "│": "├", "┌": "├", "┐": "┼", "┘": "┴", "├": "├", "┤": "┼", "┬": "┼", "┴": "┴" },
  "┘": { "─": "┴", "│": "┤", "┌": "┼", "┐": "┤", "└": "┴", "├": "┼", "┤": "┤", "┬": "┼", "┴": "┴" },
  "├": { "─": "┼", "│": "├", "┌": "├", "┐": "┼", "└": "├", "┘": "┼", "┤": "┼", "┬": "┼", "┴": "┼" },
  "┤": { "─": "┼", "│": "┤", "┌": "┼", "┐": "┤", "└": "┼", "┘": "┤", "├": "┼", "┬": "┼", "┴": "┼" },
  "┬": { "─": "┬", "│": "┼", "┌": "┬", "┐": "┬", "└": "┼", "┘": "┼", "├": "┼", "┤": "┼", "┴": "┼" },
  "┴": { "─": "┴", "│": "┼", "┌": "┼", "┐": "┼", "└": "┴", "┘": "┴", "├": "┼", "┤": "┼", "┬": "┼" },
};
export function mergeJunctions(c1: string, c2: string): string {
  return JUNCTION_MAP[c1]?.[c2] ?? c1;
}
export function mergeCanvases(
  base: Canvas,
  offset: DrawingCoord,
  useAscii: boolean,
  ...overlays: Canvas[]
): Canvas {
  let [maxX, maxY] = getCanvasSize(base);
  for (const overlay of overlays) {
    const [oX, oY] = getCanvasSize(overlay);
    maxX = Math.max(maxX, oX + offset.x);
    maxY = Math.max(maxY, oY + offset.y);
  }
  const merged = mkCanvas(maxX, maxY, base.budget);
  for (let x = 0; x <= maxX; x++) {
    for (let y = 0; y <= maxY; y++) {
      if (x < base.length && y < base[0]!.length) {
        merged[x]![y] = base[x]![y]!;
      }
    }
  }
  for (const overlay of overlays) {
    base.budget?.check();
    for (let x = 0; x < overlay.length; x++) {
      for (let y = 0; y < overlay[0]!.length; y++) {
        const c = overlay[x]![y]!;
        if (c !== " ") {
          const mx = x + offset.x;
          const my = y + offset.y;
          const current = merged[mx]![my]!;
          if (!useAscii && isJunctionChar(c) && isJunctionChar(current)) {
            merged[mx]![my] = mergeJunctions(current, c);
          } else if (isAlphanumeric(current) && isAlphanumeric(c)) {
          } else {
            merged[mx]![my] = c;
          }
        }
      }
    }
  }
  return merged;
}
export function canvasToString(canvas: Canvas): string {
  const [maxX, maxY] = getCanvasSize(canvas);
  validateCanvas(maxX + 1, maxY + 1);
  canvas.budget?.check();
  const lines: string[] = [];
  for (let y = 0; y <= maxY; y++) {
    let line = "";
    for (let x = 0; x <= maxX; x++) line += canvas[x]![y]!;
    lines.push(line);
  }
  return lines.join("\n");
}
const VERTICAL_FLIP_MAP: Record<string, string> = {
  "▲": "▼",
  "▼": "▲",
  "◤": "◣",
  "◣": "◤",
  "◥": "◢",
  "◢": "◥",
  "^": "v",
  v: "^",
  "┌": "└",
  "└": "┌",
  "┐": "┘",
  "┘": "┐",
  "┬": "┴",
  "┴": "┬",
  "╵": "╷",
  "╷": "╵",
};
export function flipTextVertically(text: string): string {
  const lines = text.split("\n");
  const flipped: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    flipped.push(Array.from(lines[index]!, (char) => VERTICAL_FLIP_MAP[char] ?? char).join(""));
  }
  return flipped.join("\n");
}
export function flipCanvasVertically(canvas: Canvas): Canvas {
  for (const col of canvas) {
    col.reverse();
  }
  for (const col of canvas) {
    for (let y = 0; y < col.length; y++) {
      const flipped = VERTICAL_FLIP_MAP[col[y]!];
      if (flipped) col[y] = flipped;
    }
  }
  return canvas;
}
export function drawText(
  canvas: Canvas,
  start: DrawingCoord,
  text: string,
  forceOverwrite = false,
): void {
  increaseSize(canvas, start.x + text.length, start.y);
  for (let i = 0; i < text.length; i++) {
    const x = start.x + i;
    const current = canvas[x]![start.y]!;
    if (forceOverwrite || current === " ") {
      canvas[x]![start.y] = text[i]!;
    }
  }
}
export function setCanvasSizeToGrid(
  canvas: Canvas,
  columnWidth: Map<number, number>,
  rowHeight: Map<number, number>,
): void {
  let maxX = 0;
  let maxY = 0;
  for (const w of columnWidth.values()) maxX += w;
  for (const h of rowHeight.values()) maxY += h;
  increaseSize(canvas, maxX - 1, maxY - 1);
}
