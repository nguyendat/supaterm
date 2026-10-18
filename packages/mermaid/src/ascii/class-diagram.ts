import { diagramLines } from "../diagram.ts";
import { parseClassDiagram } from "../class/parser.ts";
import type { ClassNode, ClassMember, RelationshipType } from "../class/types.ts";
import type { AsciiConfig } from "./types.ts";
import { mkCanvas, canvasToString, increaseSize } from "./canvas.ts";
import { drawMultiBox } from "./draw.ts";
import { splitLines } from "./multiline-utils.ts";
function formatMember(m: ClassMember): string {
  const vis = m.visibility || "";
  const type = m.type ? `: ${m.type}` : "";
  return `${vis}${m.name}${type}`;
}
function buildClassSections(cls: ClassNode): string[][] {
  const header: string[] = [];
  if (cls.annotation) header.push(`<<${cls.annotation}>>`);
  const nameLines = splitLines(cls.label);
  header.push(...nameLines);
  const attrs = cls.attributes.map(formatMember);
  const methods = cls.methods.map(formatMember);
  if (attrs.length === 0 && methods.length === 0) return [header];
  if (methods.length === 0) return [header, attrs];
  return [header, attrs, methods];
}
interface RelMarker {
  type: RelationshipType;
  markerAt: "from" | "to";
  dashed: boolean;
}
function getRelMarker(type: RelationshipType, markerAt: "from" | "to"): RelMarker {
  const dashed = type === "dependency" || type === "realization";
  return { type, markerAt, dashed };
}
function getMarkerShape(
  type: RelationshipType,
  useAscii: boolean,
  direction?: "up" | "down" | "left" | "right",
): string {
  switch (type) {
    case "inheritance":
    case "realization":
      if (direction === "down") {
        return useAscii ? "^" : "△";
      } else if (direction === "up") {
        return useAscii ? "v" : "▽";
      } else if (direction === "left") {
        return useAscii ? ">" : "◁";
      } else {
        return useAscii ? "<" : "▷";
      }
    case "composition":
      return useAscii ? "*" : "◆";
    case "aggregation":
      return useAscii ? "o" : "◇";
    case "association":
    case "dependency":
      if (direction === "down") {
        return useAscii ? "v" : "▼";
      } else if (direction === "up") {
        return useAscii ? "^" : "▲";
      } else if (direction === "left") {
        return useAscii ? "<" : "◀";
      } else {
        return useAscii ? ">" : "▶";
      }
  }
}
interface PlacedClass {
  cls: ClassNode;
  sections: string[][];
  x: number;
  y: number;
  width: number;
  height: number;
}
export function renderClassAscii(text: string, config: AsciiConfig): string {
  const lines = diagramLines(text);
  const diagram = parseClassDiagram(lines);
  config.budget?.check();
  if (diagram.classes.length === 0) return "";
  const useAscii = config.useAscii;
  const hGap = 4;
  const vGap = 3;
  const classSections = new Map<string, string[][]>();
  const classBoxW = new Map<string, number>();
  const classBoxH = new Map<string, number>();
  for (const cls of diagram.classes) {
    const sections = buildClassSections(cls);
    classSections.set(cls.id, sections);
    let maxTextW = 0;
    for (const section of sections) {
      for (const line of section) maxTextW = Math.max(maxTextW, line.length);
    }
    const boxW = maxTextW + 4;
    let totalLines = 0;
    for (const section of sections) totalLines += Math.max(section.length, 1);
    const boxH = totalLines + (sections.length - 1) + 2;
    classBoxW.set(cls.id, boxW);
    classBoxH.set(cls.id, boxH);
  }
  const classById = new Map<string, ClassNode>();
  for (const cls of diagram.classes) classById.set(cls.id, cls);
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const rel of diagram.relationships) {
    config.budget?.check();
    const isHierarchical = rel.type === "inheritance" || rel.type === "realization";
    const parentId = isHierarchical && rel.markerAt === "to" ? rel.to : rel.from;
    const childId = isHierarchical && rel.markerAt === "to" ? rel.from : rel.to;
    if (!parents.has(childId)) parents.set(childId, new Set());
    parents.get(childId)!.add(parentId);
    if (!children.has(parentId)) children.set(parentId, new Set());
    children.get(parentId)!.add(childId);
  }
  const level = new Map<string, number>();
  const roots = diagram.classes.filter((c) => !parents.has(c.id) || parents.get(c.id)!.size === 0);
  const queue: string[] = roots.map((c) => c.id);
  for (const id of queue) level.set(id, 0);
  const levelCap = diagram.classes.length - 1;
  let qi = 0;
  while (qi < queue.length) {
    config.budget?.check();
    const id = queue[qi++]!;
    const childSet = children.get(id);
    if (!childSet) continue;
    for (const childId of childSet) {
      const newLevel = (level.get(id) ?? 0) + 1;
      if (newLevel > levelCap) continue;
      if (!level.has(childId) || level.get(childId)! < newLevel) {
        level.set(childId, newLevel);
        queue.push(childId);
      }
    }
  }
  for (const cls of diagram.classes) {
    if (!level.has(cls.id)) level.set(cls.id, 0);
  }
  const maxLevel = Math.max(...level.values(), 0);
  const levelGroups: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const cls of diagram.classes) {
    levelGroups[level.get(cls.id)!]!.push(cls.id);
  }
  const placed = new Map<string, PlacedClass>();
  let currentY = 0;
  for (let lv = 0; lv <= maxLevel; lv++) {
    const group = levelGroups[lv]!;
    if (group.length === 0) continue;
    let currentX = 0;
    let maxH = 0;
    for (const id of group) {
      const cls = classById.get(id)!;
      const w = classBoxW.get(id)!;
      const h = classBoxH.get(id)!;
      placed.set(id, {
        cls,
        sections: classSections.get(id)!,
        x: currentX,
        y: currentY,
        width: w,
        height: h,
      });
      currentX += w + hGap;
      maxH = Math.max(maxH, h);
    }
    currentY += maxH + vGap;
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
  const boxOccupancy: { x1: number; x2: number; y1: number; y2: number }[] = [];
  for (const p of placed.values()) {
    boxOccupancy.push({ x1: p.x, x2: p.x + p.width - 1, y1: p.y, y2: p.y + p.height - 1 });
  }
  function isInsideBox(x: number, y: number, excludeIds?: Set<string>): boolean {
    for (const [id, p] of placed.entries()) {
      if (excludeIds?.has(id)) continue;
      if (x >= p.x && x <= p.x + p.width - 1 && y >= p.y && y <= p.y + p.height - 1) {
        return true;
      }
    }
    return false;
  }
  function findClearColumn(
    startX: number,
    y1: number,
    y2: number,
    excludeIds: Set<string>,
  ): number {
    let clear = true;
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      if (isInsideBox(startX, y, excludeIds)) {
        clear = false;
        break;
      }
    }
    if (clear) return startX;
    for (let offset = 1; offset < totalW + 10; offset++) {
      const rightX = startX + offset;
      clear = true;
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        if (isInsideBox(rightX, y, excludeIds)) {
          clear = false;
          break;
        }
      }
      if (clear) return rightX;
      const leftX = startX - offset;
      if (leftX >= 0) {
        clear = true;
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          if (isInsideBox(leftX, y, excludeIds)) {
            clear = false;
            break;
          }
        }
        if (clear) return leftX;
      }
    }
    return totalW + 2;
  }
  const H = useAscii ? "-" : "─";
  const V = useAscii ? "|" : "│";
  const dashH = useAscii ? "." : "╌";
  const dashV = useAscii ? ":" : "┊";
  for (const rel of diagram.relationships) {
    config.budget?.check();
    const fromP = placed.get(rel.from);
    const toP = placed.get(rel.to);
    if (!fromP || !toP) continue;
    const marker = getRelMarker(rel.type, rel.markerAt);
    const lineH = marker.dashed ? dashH : H;
    const lineV = marker.dashed ? dashV : V;
    const excludeIds = new Set([rel.from, rel.to]);
    const fromCX = fromP.x + Math.floor(fromP.width / 2);
    const fromBY = fromP.y + fromP.height - 1;
    const toCX = toP.x + Math.floor(toP.width / 2);
    const toTY = toP.y;
    if (fromBY < toTY) {
      const routeX = findClearColumn(fromCX, fromBY + 1, toTY - 1, excludeIds);
      const needsDetour = routeX !== fromCX;
      if (routeX >= totalW) {
        increaseSize(canvas, routeX + 2, totalH);
      }
      if (needsDetour) {
        const exitY = fromBY + 1;
        const entryY = toTY - 1;
        const lx1 = Math.min(fromCX, routeX);
        const rx1 = Math.max(fromCX, routeX);
        for (let x = lx1; x <= rx1; x++) {
          setC(x, exitY, lineH);
        }
        if (!useAscii && exitY < (canvas[0]?.length ?? 0)) {
          if (fromCX < routeX) {
            setC(fromCX, exitY, "└");
            setC(routeX, exitY, "┐");
          } else {
            setC(fromCX, exitY, "┘");
            setC(routeX, exitY, "┌");
          }
        }
        for (let y = exitY + 1; y <= entryY; y++) {
          setC(routeX, y, lineV);
        }
        if (routeX !== toCX) {
          const lx2 = Math.min(routeX, toCX);
          const rx2 = Math.max(routeX, toCX);
          for (let x = lx2; x <= rx2; x++) {
            setC(x, entryY, lineH);
          }
          if (!useAscii && entryY < (canvas[0]?.length ?? 0)) {
            if (routeX < toCX) {
              setC(routeX, entryY, "└");
              setC(toCX, entryY, "┐");
            } else {
              setC(routeX, entryY, "┘");
              setC(toCX, entryY, "┌");
            }
          }
        }
        if (marker.markerAt === "to") {
          const markerChar = getMarkerShape(marker.type, useAscii, "down");
          setC(toCX, entryY, markerChar);
        }
        if (marker.markerAt === "from") {
          const markerChar = getMarkerShape(marker.type, useAscii, "down");
          setC(fromCX, fromBY + 1, markerChar);
        }
      } else {
        const midY = fromBY + Math.floor((toTY - fromBY) / 2);
        for (let y = fromBY + 1; y <= midY; y++) {
          setC(fromCX, y, lineV);
        }
        if (fromCX !== toCX && midY < (canvas[0]?.length ?? 0)) {
          const lx = Math.min(fromCX, toCX);
          const rx = Math.max(fromCX, toCX);
          for (let x = lx; x <= rx; x++) {
            setC(x, midY, lineH);
          }
          if (!useAscii) {
            setC(fromCX, midY, fromCX < toCX ? "└" : "┘");
            setC(toCX, midY, fromCX < toCX ? "┐" : "┌");
          }
        }
        for (let y = midY + 1; y < toTY; y++) {
          setC(toCX, y, lineV);
        }
        if (marker.markerAt === "to") {
          setC(toCX, toTY - 1, getMarkerShape(marker.type, useAscii, "down"));
        }
        if (marker.markerAt === "from") {
          setC(fromCX, fromBY + 1, getMarkerShape(marker.type, useAscii, "down"));
        }
      }
    } else if (toP.y + toP.height - 1 < fromP.y) {
      const fromTY = fromP.y;
      const toBY = toP.y + toP.height - 1;
      const midY = toBY + Math.floor((fromTY - toBY) / 2);
      for (let y = fromTY - 1; y >= midY; y--) {
        setC(fromCX, y, lineV);
      }
      if (fromCX !== toCX) {
        const lx = Math.min(fromCX, toCX);
        const rx = Math.max(fromCX, toCX);
        for (let x = lx; x <= rx; x++) {
          setC(x, midY, lineH);
        }
        if (!useAscii && midY >= 0 && midY < totalH) {
          setC(fromCX, midY, fromCX < toCX ? "┌" : "┐");
          setC(toCX, midY, fromCX < toCX ? "┘" : "└");
        }
      }
      for (let y = midY - 1; y > toBY; y--) {
        setC(toCX, y, lineV);
      }
      if (marker.markerAt === "from") {
        const markerChar = getMarkerShape(marker.type, useAscii, "up");
        const my = fromTY - 1;
        for (let i = 0; i < markerChar.length; i++) {
          setC(fromCX - Math.floor(markerChar.length / 2) + i, my, markerChar[i]!);
        }
      }
      if (marker.markerAt === "to") {
        const isHierarchical = marker.type === "inheritance" || marker.type === "realization";
        const markerDir = isHierarchical ? "down" : "up";
        const markerChar = getMarkerShape(marker.type, useAscii, markerDir);
        const my = toBY + 1;
        for (let i = 0; i < markerChar.length; i++) {
          setC(toCX - Math.floor(markerChar.length / 2) + i, my, markerChar[i]!);
        }
      }
    } else {
      const detourY = Math.max(fromBY, toP.y + toP.height - 1) + 2;
      increaseSize(canvas, totalW, detourY + 1);
      for (let y = fromBY + 1; y <= detourY; y++) {
        setC(fromCX, y, lineV);
      }
      const lx = Math.min(fromCX, toCX);
      const rx = Math.max(fromCX, toCX);
      for (let x = lx; x <= rx; x++) {
        setC(x, detourY, lineH);
      }
      for (let y = detourY - 1; y >= toP.y + toP.height; y--) {
        setC(toCX, y, lineV);
      }
      if (marker.markerAt === "from") {
        const markerChar = getMarkerShape(marker.type, useAscii, "down");
        const my = fromBY + 1;
        for (let i = 0; i < markerChar.length; i++) {
          setC(fromCX - Math.floor(markerChar.length / 2) + i, my, markerChar[i]!);
        }
      }
      if (marker.markerAt === "to") {
        const markerChar = getMarkerShape(marker.type, useAscii, "up");
        const my = toP.y + toP.height;
        for (let i = 0; i < markerChar.length; i++) {
          setC(toCX - Math.floor(markerChar.length / 2) + i, my, markerChar[i]!);
        }
      }
    }
    if (rel.label) {
      const lines = splitLines(rel.label);
      const maxLabelWidth = Math.max(...lines.map((l) => l.length)) + 2;
      let baseMidY: number;
      let idealMidX: number;
      if (fromBY < toTY) {
        baseMidY = Math.floor((fromBY + 1 + toTY - 1) / 2);
        idealMidX = Math.floor((fromCX + toCX) / 2);
      } else if (toP.y + toP.height - 1 < fromP.y) {
        const toBY = toP.y + toP.height - 1;
        baseMidY = Math.floor((toBY + 1 + fromP.y - 1) / 2);
        idealMidX = Math.floor((fromCX + toCX) / 2);
      } else {
        baseMidY = Math.max(fromBY, toP.y + toP.height - 1) + 2;
        idealMidX = Math.floor((fromCX + toCX) / 2);
      }
      let labelY = baseMidY;
      const halfHeight = Math.floor(lines.length / 2);
      let labelInBox = false;
      for (let i = 0; i < lines.length; i++) {
        const y = labelY - halfHeight + i;
        const idealLabelStart = idealMidX - Math.floor(maxLabelWidth / 2);
        const labelStart = Math.max(0, idealLabelStart);
        for (let x = labelStart; x < labelStart + maxLabelWidth; x++) {
          if (isInsideBox(x, y, excludeIds)) {
            labelInBox = true;
            break;
          }
        }
        if (labelInBox) break;
      }
      if (labelInBox) {
        const gapTop = fromBY + 1;
        const gapBottom = toTY - 1;
        for (let y = gapTop; y <= gapBottom; y++) {
          let clearRow = true;
          const idealLabelStart = idealMidX - Math.floor(maxLabelWidth / 2);
          const labelStart = Math.max(0, idealLabelStart);
          for (let x = labelStart; x < labelStart + maxLabelWidth; x++) {
            if (isInsideBox(x, y, excludeIds)) {
              clearRow = false;
              break;
            }
          }
          if (clearRow) {
            labelY = y;
            break;
          }
        }
      }
      const startY = labelY - halfHeight;
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const paddedLine = ` ${lines[lineIdx]!} `;
        const idealLabelStart = idealMidX - Math.floor(paddedLine.length / 2);
        const labelStart = Math.max(0, idealLabelStart);
        const y = startY + lineIdx;
        const labelEnd = labelStart + paddedLine.length;
        if (labelEnd > 0 && y >= 0) {
          increaseSize(canvas, Math.max(labelEnd, 1), Math.max(y + 1, 1));
        }
        for (let i = 0; i < paddedLine.length; i++) {
          const lx = labelStart + i;
          if (lx >= 0 && y >= 0) {
            setC(lx, y, paddedLine[i]!);
          }
        }
      }
    }
  }
  return canvasToString(canvas);
}
