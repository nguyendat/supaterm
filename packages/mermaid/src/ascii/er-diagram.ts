import { parseErDiagram } from "../er/parser.ts";
import type { ErDiagram, ErEntity, ErAttribute, Cardinality } from "../er/types.ts";
import type { AsciiConfig } from "./types.ts";
import { mkCanvas, canvasToString, increaseSize } from "./canvas.ts";
import { drawMultiBox } from "./draw.ts";
import { splitLines } from "./multiline-utils.ts";
function formatAttribute(attr: ErAttribute): string {
  const keyStr = attr.keys.length > 0 ? attr.keys.join(",") + " " : "   ";
  return `${keyStr}${attr.type} ${attr.name}`;
}
function buildEntitySections(entity: ErEntity): string[][] {
  const header = splitLines(entity.label);
  const attrs = entity.attributes.map(formatAttribute);
  if (attrs.length === 0) return [header];
  return [header, attrs];
}
function getCrowsFootChars(card: Cardinality, useAscii: boolean, isRight = false): string {
  if (useAscii) {
    switch (card) {
      case "one":
        return "|";
      case "zero-one":
        return "o|";
      case "many":
        return isRight ? "<" : ">";
      case "zero-many":
        return isRight ? "o<" : ">o";
    }
  } else {
    switch (card) {
      case "one":
        return "│";
      case "zero-one":
        return "○│";
      case "many":
        return isRight ? "╟" : "╢";
      case "zero-many":
        return isRight ? "○╟" : "╢○";
    }
  }
}
interface PlacedEntity {
  entity: ErEntity;
  sections: string[][];
  x: number;
  y: number;
  width: number;
  height: number;
}
function findConnectedComponents(diagram: ErDiagram): Set<string>[] {
  const visited = new Set<string>();
  const components: Set<string>[] = [];
  const neighbors = new Map<string, Set<string>>();
  for (const ent of diagram.entities) {
    neighbors.set(ent.id, new Set());
  }
  for (const rel of diagram.relationships) {
    neighbors.get(rel.entity1)?.add(rel.entity2);
    neighbors.get(rel.entity2)?.add(rel.entity1);
  }
  function dfs(startId: string, component: Set<string>): void {
    const stack = [startId];
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      component.add(nodeId);
      for (const neighbor of neighbors.get(nodeId) ?? []) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }
  }
  for (const ent of diagram.entities) {
    if (!visited.has(ent.id)) {
      const component = new Set<string>();
      dfs(ent.id, component);
      if (component.size > 0) {
        components.push(component);
      }
    }
  }
  return components;
}
export function renderErAscii(text: string, config: AsciiConfig): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
  const diagram = parseErDiagram(lines);
  config.budget?.check();
  if (diagram.entities.length === 0) return "";
  const useAscii = config.useAscii;
  const hGap = 6;
  const vGap = 4;
  const componentGap = 6;
  const entitySections = new Map<string, string[][]>();
  const entityBoxW = new Map<string, number>();
  const entityBoxH = new Map<string, number>();
  const entityById = new Map<string, ErEntity>();
  for (const ent of diagram.entities) {
    entityById.set(ent.id, ent);
    const sections = buildEntitySections(ent);
    entitySections.set(ent.id, sections);
    let maxTextW = 0;
    for (const section of sections) {
      for (const line of section) maxTextW = Math.max(maxTextW, line.length);
    }
    const boxW = maxTextW + 4;
    let totalLines = 0;
    for (const section of sections) totalLines += Math.max(section.length, 1);
    const boxH = totalLines + (sections.length - 1) + 2;
    entityBoxW.set(ent.id, boxW);
    entityBoxH.set(ent.id, boxH);
  }
  const components = findConnectedComponents(diagram);
  const placed = new Map<string, PlacedEntity>();
  let currentY = 0;
  for (const component of components) {
    const componentEntities = diagram.entities.filter((e) => component.has(e.id));
    const maxPerRow = Math.max(2, Math.ceil(Math.sqrt(componentEntities.length)));
    let currentX = 0;
    let maxRowH = 0;
    let colCount = 0;
    for (const ent of componentEntities) {
      const w = entityBoxW.get(ent.id)!;
      const h = entityBoxH.get(ent.id)!;
      if (colCount >= maxPerRow) {
        currentY += maxRowH + vGap;
        currentX = 0;
        maxRowH = 0;
        colCount = 0;
      }
      placed.set(ent.id, {
        entity: ent,
        sections: entitySections.get(ent.id)!,
        x: currentX,
        y: currentY,
        width: w,
        height: h,
      });
      currentX += w + hGap;
      maxRowH = Math.max(maxRowH, h);
      colCount++;
    }
    currentY += maxRowH + componentGap;
  }
  let totalW = 0;
  let totalH = 0;
  for (const p of placed.values()) {
    totalW = Math.max(totalW, p.x + p.width);
    totalH = Math.max(totalH, p.y + p.height);
  }
  totalW += 4;
  totalH += 2;
  const canvas = mkCanvas(totalW - 1, totalH - 1, config.budget);
  function setC(x: number, y: number, ch: string): void {
    if (x >= 0 && x < canvas.length && y >= 0 && y < (canvas[0]?.length ?? 0)) {
      canvas[x]![y] = ch;
    }
  }
  for (const p of placed.values()) {
    const boxCanvas = drawMultiBox(p.sections, useAscii, 1, config.budget);
    for (let bx = 0; bx < boxCanvas.length; bx++) {
      for (let by = 0; by < boxCanvas[0]!.length; by++) {
        const ch = boxCanvas[bx]![by]!;
        if (ch !== " ") {
          const cx = p.x + bx;
          const cy = p.y + by;
          if (cx < totalW && cy < totalH) {
            setC(cx, cy, ch);
          }
        }
      }
    }
  }
  const H = useAscii ? "-" : "─";
  const V = useAscii ? "|" : "│";
  const dashH = useAscii ? "." : "╌";
  const dashV = useAscii ? ":" : "┊";
  for (const rel of diagram.relationships) {
    config.budget?.check();
    const e1 = placed.get(rel.entity1);
    const e2 = placed.get(rel.entity2);
    if (!e1 || !e2) continue;
    const lineH = rel.identifying ? H : dashH;
    const lineV = rel.identifying ? V : dashV;
    const e1CX = e1.x + Math.floor(e1.width / 2);
    const e1CY = e1.y + Math.floor(e1.height / 2);
    const e2CX = e2.x + Math.floor(e2.width / 2);
    const e2CY = e2.y + Math.floor(e2.height / 2);
    const sameRow = Math.abs(e1CY - e2CY) < Math.max(e1.height, e2.height);
    if (sameRow) {
      const [left, right] = e1CX < e2CX ? [e1, e2] : [e2, e1];
      const [leftCard, rightCard] =
        e1CX < e2CX ? [rel.cardinality1, rel.cardinality2] : [rel.cardinality2, rel.cardinality1];
      const startX = left.x + left.width;
      const endX = right.x - 1;
      const lineY = left.y + Math.floor(left.height / 2);
      for (let x = startX; x <= endX; x++) {
        setC(x, lineY, lineH);
      }
      const leftChars = getCrowsFootChars(leftCard, useAscii, false);
      for (let i = 0; i < leftChars.length; i++) {
        setC(startX + i, lineY, leftChars[i]!);
      }
      const rightChars = getCrowsFootChars(rightCard, useAscii, true);
      for (let i = 0; i < rightChars.length; i++) {
        setC(endX - rightChars.length + 1 + i, lineY, rightChars[i]!);
      }
      if (rel.label) {
        const lines = splitLines(rel.label);
        const gapMid = Math.floor((startX + endX) / 2);
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx]!;
          const labelStart = Math.max(startX, gapMid - Math.floor(line.length / 2));
          const labelY = lineY + 1 + lineIdx;
          increaseSize(canvas, Math.max(labelStart + line.length, 1), Math.max(labelY + 1, 1));
          for (let i = 0; i < line.length; i++) {
            const lx = labelStart + i;
            if (lx >= startX && lx <= endX) {
              setC(lx, labelY, line[i]!);
            }
          }
        }
      }
    } else {
      const [upper, lower] = e1CY < e2CY ? [e1, e2] : [e2, e1];
      const [upperCard, lowerCard] =
        e1CY < e2CY ? [rel.cardinality1, rel.cardinality2] : [rel.cardinality2, rel.cardinality1];
      const startY = upper.y + upper.height;
      const endY = lower.y - 1;
      const lineX = upper.x + Math.floor(upper.width / 2);
      for (let y = startY; y <= endY; y++) {
        setC(lineX, y, lineV);
      }
      const lowerCX = lower.x + Math.floor(lower.width / 2);
      if (lineX !== lowerCX) {
        const midY = Math.floor((startY + endY) / 2);
        const lx = Math.min(lineX, lowerCX);
        const rx = Math.max(lineX, lowerCX);
        for (let x = lx; x <= rx; x++) {
          setC(x, midY, lineH);
        }
        for (let y = midY + 1; y <= endY; y++) {
          setC(lowerCX, y, lineV);
        }
      }
      const upperChars = getCrowsFootChars(upperCard, useAscii, false);
      for (let i = 0; i < upperChars.length; i++) {
        setC(lineX - Math.floor(upperChars.length / 2) + i, startY, upperChars[i]!);
      }
      const targetX = lineX !== lowerCX ? lowerCX : lineX;
      const lowerChars = getCrowsFootChars(lowerCard, useAscii, true);
      for (let i = 0; i < lowerChars.length; i++) {
        setC(targetX - Math.floor(lowerChars.length / 2) + i, endY, lowerChars[i]!);
      }
      if (rel.label) {
        const lines = splitLines(rel.label);
        const midY = Math.floor((startY + endY) / 2);
        const startLabelY = midY - Math.floor((lines.length - 1) / 2);
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx]!;
          const labelX = lineX + 2;
          const y = startLabelY + lineIdx;
          if (y >= 0) {
            for (let i = 0; i < line.length; i++) {
              const lx = labelX + i;
              if (lx >= 0) {
                increaseSize(canvas, lx + 1, y + 1);
                setC(lx, y, line[i]!);
              }
            }
          }
        }
      }
    }
  }
  return canvasToString(canvas);
}
