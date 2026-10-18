import { MERMAID_LIMITS as limits } from "./limits.ts";

export function checkLimit(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`Mermaid ${name} exceeds the supported limit (${maximum})`);
  }
}

export function validateSource(text: string): void {
  if (typeof text !== "string") throw new TypeError("Mermaid source must be a string");
  checkLimit(text.length, limits.sourceChars, "source length");
  const lines = text.split("\n");
  checkLimit(lines.length, limits.sourceLines, "source lines");
  for (const line of lines) checkLimit(line.length, limits.lineChars, "line length");
}

export function validateCanvas(width: number, height: number): number {
  checkLimit(width, limits.canvasDimension, "canvas width");
  checkLimit(height, limits.canvasDimension, "canvas height");
  const cells = width * height;
  checkLimit(cells, limits.canvasCells, "canvas cells");
  return cells;
}

export class RenderBudget {
  private readonly deadline = globalThis.performance.now() + limits.durationMs;
  private allocatedCells = 0;
  private pathVisits = 0;

  check(): void {
    if (globalThis.performance.now() > this.deadline)
      throw new RangeError("Mermaid rendering time limit exceeded");
  }

  allocate(width: number, height: number): void {
    this.check();
    this.allocatedCells += validateCanvas(width, height);
    checkLimit(this.allocatedCells, limits.allocatedCells, "allocated cells");
  }

  visitPath(): void {
    this.pathVisits++;
    checkLimit(this.pathVisits, limits.totalPathVisits, "pathfinding work");
    if (this.pathVisits % 256 === 0) this.check();
  }
}
