import { validateCanvas, type RenderBudget } from "../budget.ts";
import { parseXYChart } from "../xychart/parser.ts";
import type { XYChart } from "../xychart/types.ts";
import type { AsciiConfig, Canvas } from "./types.ts";
const PLOT_WIDTH = 60;
const PLOT_HEIGHT = 20;
const UNI = {
  hLine: "─",
  vLine: "│",
  origin: "┼",
  yTick: "┤",
  xTick: "┬",
  bar: "█",
  grid: "·",
  cornerTL: "╭",
  cornerTR: "╮",
  cornerBL: "╰",
  cornerBR: "╯",
} as const;
const ASC = {
  hLine: "-",
  vLine: "|",
  origin: "+",
  yTick: "+",
  xTick: "+",
  bar: "#",
  grid: ".",
  cornerTL: "+",
  cornerTR: "+",
  cornerBL: "+",
  cornerBR: "+",
} as const;
export function renderXYChartAscii(text: string, config: AsciiConfig): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
  const chart = parseXYChart(lines);
  config.budget?.check();
  const ch = config.useAscii ? ASC : UNI;
  if (chart.horizontal) {
    return renderHorizontal(chart, ch, config.budget);
  }
  return renderVertical(chart, ch, config.budget);
}
function renderVertical(
  chart: XYChart,
  ch: typeof UNI | typeof ASC,
  budget?: RenderBudget,
): string {
  const dataCount = getDataCount(chart);
  if (dataCount === 0) return "";
  const yRange = chart.yAxis.range!;
  const yTicks = niceTickValues(yRange.min, yRange.max);
  const yLabels = yTicks.map((v) => formatTickValue(v));
  const yGutter = Math.max(...yLabels.map((l) => l.length)) + 1;
  const plotW = Math.max(PLOT_WIDTH, dataCount * 6);
  const plotH = PLOT_HEIGHT;
  const bandW = Math.floor(plotW / dataCount);
  const catLabels = getCategoryLabels(chart, dataCount);
  const hasTitle = !!chart.title;
  const hasXTitle = !!chart.xAxis.title;
  const hasLegend = chart.series.length > 1;
  const titleRow = hasTitle ? 0 : -1;
  const plotTop = (hasTitle ? 2 : 0) + (hasLegend ? 1 : 0);
  const plotLeft = yGutter + 1;
  const totalW = plotLeft + bandW * dataCount + 2;
  const xAxisRow = plotTop + plotH;
  const xLabelRow = xAxisRow + 1;
  const xTitleRow = hasXTitle ? xLabelRow + 1 : -1;
  const totalH = xLabelRow + 1 + (hasXTitle ? 1 : 0) + (hasLegend && !hasTitle ? 0 : 0);
  const canvas = createCanvas(totalW, totalH, budget);
  const valueToRow = (v: number): number => {
    const t = (v - yRange.min) / (yRange.max - yRange.min || 1);
    return Math.round(Math.max(0, Math.min(1, t)) * (plotH - 1));
  };
  const bandCenter = (i: number): number => plotLeft + Math.floor(bandW * (i + 0.5));
  if (hasTitle && titleRow >= 0) {
    writeText(canvas, titleRow, Math.floor(totalW / 2 - chart.title!.length / 2), chart.title!);
  }
  if (hasLegend) {
    const legendRow = hasTitle ? 1 : 0;
    drawLegend(canvas, chart, legendRow, totalW, ch);
  }
  for (let row = 0; row < plotH; row++) {
    const displayRow = plotTop + (plotH - 1 - row);
    set(canvas, displayRow, plotLeft - 1, ch.vLine);
  }
  set(canvas, xAxisRow, plotLeft - 1, ch.origin);
  for (const tick of yTicks) {
    const row = valueToRow(tick);
    if (row < 0 || row >= plotH) continue;
    const displayRow = plotTop + (plotH - 1 - row);
    const label = formatTickValue(tick);
    set(canvas, displayRow, plotLeft - 1, row === 0 ? ch.origin : ch.yTick);
    const labelStart = yGutter - label.length;
    writeText(canvas, displayRow, Math.max(0, labelStart), label);
  }
  for (let c = plotLeft; c < plotLeft + bandW * dataCount; c++) {
    set(canvas, xAxisRow, c, ch.hLine);
  }
  for (let i = 0; i < dataCount; i++) {
    const cx = bandCenter(i);
    set(canvas, xAxisRow, cx, ch.xTick);
    const label = catLabels[i]!;
    const labelStart = cx - Math.floor(label.length / 2);
    writeText(canvas, xLabelRow, Math.max(0, labelStart), label);
  }
  if (hasXTitle && xTitleRow >= 0) {
    const title = chart.xAxis.title!;
    writeText(canvas, xTitleRow, Math.floor(totalW / 2 - title.length / 2), title);
  }
  for (const tick of yTicks) {
    const row = valueToRow(tick);
    if (row < 0 || row >= plotH) continue;
    const displayRow = plotTop + (plotH - 1 - row);
    for (let c = plotLeft; c < plotLeft + bandW * dataCount; c++) {
      if (get(canvas, displayRow, c) === " ") {
        set(canvas, displayRow, c, ch.grid);
      }
    }
  }
  const barEntries: { data: number[] }[] = [];
  for (let si = 0; si < chart.series.length; si++) {
    if (chart.series[si]!.type === "bar") barEntries.push({ data: chart.series[si]!.data });
  }
  if (barEntries.length > 0) {
    const barCount = barEntries.length;
    const usable = Math.max(1, bandW - 2);
    const singleBarW = Math.max(1, Math.min(Math.floor(usable / barCount), 8));
    const groupW = singleBarW * barCount + (barCount - 1);
    const baseRow = valueToRow(Math.max(0, yRange.min));
    for (let bIdx = 0; bIdx < barEntries.length; bIdx++) {
      const entry = barEntries[bIdx]!;
      for (let i = 0; i < entry.data.length; i++) {
        const cx = bandCenter(i);
        const groupLeft = cx - Math.floor(groupW / 2);
        const bx = groupLeft + bIdx * (singleBarW + 1);
        const valRow = valueToRow(entry.data[i]!);
        const fromRow = Math.min(baseRow, valRow);
        const toRow = Math.max(baseRow, valRow);
        for (let row = fromRow; row <= toRow; row++) {
          const displayRow = plotTop + (plotH - 1 - row);
          for (let c = bx; c < bx + singleBarW; c++) {
            set(canvas, displayRow, c, ch.bar);
          }
        }
      }
    }
  }
  const lineEntries: { data: number[] }[] = [];
  for (let si = 0; si < chart.series.length; si++) {
    if (chart.series[si]!.type === "line") lineEntries.push({ data: chart.series[si]!.data });
  }
  for (const entry of lineEntries) {
    if (entry.data.length === 0) continue;
    drawStaircaseLine(
      canvas,
      entry.data,
      bandCenter,
      valueToRow,
      plotTop,
      plotH,
      plotLeft,
      bandW * dataCount,
      ch,
    );
  }
  return canvasToString(canvas);
}
function renderHorizontal(
  chart: XYChart,
  ch: typeof UNI | typeof ASC,
  budget?: RenderBudget,
): string {
  const dataCount = getDataCount(chart);
  if (dataCount === 0) return "";
  const yRange = chart.yAxis.range!;
  const valueTicks = niceTickValues(yRange.min, yRange.max);
  const catLabels = getCategoryLabels(chart, dataCount);
  const catGutter = Math.max(...catLabels.map((l) => l.length)) + 1;
  const plotW = Math.max(PLOT_WIDTH, 40);
  const bandH = Math.max(2, Math.floor(PLOT_HEIGHT / dataCount));
  const plotH = bandH * dataCount;
  const hasTitle = !!chart.title;
  const hasYTitle = !!chart.yAxis.title;
  const hasLegend = chart.series.length > 1;
  const plotTop = (hasTitle ? 2 : 0) + (hasLegend ? 1 : 0);
  const plotLeft = catGutter + 1;
  const totalW = plotLeft + plotW + 2;
  const totalH = plotTop + plotH + 2 + (hasYTitle ? 1 : 0);
  const xAxisRow = plotTop + plotH;
  const canvas = createCanvas(totalW, totalH, budget);
  const valueToCol = (v: number): number => {
    const t = (v - yRange.min) / (yRange.max - yRange.min || 1);
    return plotLeft + Math.round(Math.max(0, Math.min(1, t)) * (plotW - 1));
  };
  const bandMid = (i: number): number => plotTop + Math.floor(bandH * (i + 0.5));
  if (hasTitle) {
    writeText(canvas, 0, Math.floor(totalW / 2 - chart.title!.length / 2), chart.title!);
  }
  if (hasLegend) {
    const legendRow = hasTitle ? 1 : 0;
    drawLegend(canvas, chart, legendRow, totalW, ch);
  }
  for (let r = plotTop; r < plotTop + plotH; r++) {
    set(canvas, r, plotLeft - 1, ch.vLine);
  }
  set(canvas, xAxisRow, plotLeft - 1, ch.origin);
  for (let i = 0; i < dataCount; i++) {
    const my = bandMid(i);
    const label = catLabels[i]!;
    const labelStart = catGutter - label.length;
    writeText(canvas, my, Math.max(0, labelStart), label);
  }
  for (let c = plotLeft; c < plotLeft + plotW; c++) {
    set(canvas, xAxisRow, c, ch.hLine);
  }
  for (const tick of valueTicks) {
    const cx = valueToCol(tick);
    if (cx < plotLeft || cx >= plotLeft + plotW) continue;
    set(canvas, xAxisRow, cx, ch.xTick);
    const label = formatTickValue(tick);
    writeText(canvas, xAxisRow + 1, cx - Math.floor(label.length / 2), label);
  }
  if (hasYTitle) {
    const title = chart.yAxis.title!;
    writeText(canvas, totalH - 1, Math.floor(totalW / 2 - title.length / 2), title);
  }
  for (const tick of valueTicks) {
    const cx = valueToCol(tick);
    if (cx < plotLeft || cx >= plotLeft + plotW) continue;
    for (let r = plotTop; r < plotTop + plotH; r++) {
      if (get(canvas, r, cx) === " ") {
        set(canvas, r, cx, ch.grid);
      }
    }
  }
  const barEntries: { data: number[] }[] = [];
  for (let si = 0; si < chart.series.length; si++) {
    if (chart.series[si]!.type === "bar") barEntries.push({ data: chart.series[si]!.data });
  }
  if (barEntries.length > 0) {
    const barCount = barEntries.length;
    const singleBarH = 1;
    const groupH = singleBarH * barCount + (barCount - 1);
    const baseCol = valueToCol(Math.max(0, yRange.min));
    for (let bIdx = 0; bIdx < barEntries.length; bIdx++) {
      const entry = barEntries[bIdx]!;
      for (let i = 0; i < entry.data.length; i++) {
        const my = bandMid(i);
        const groupTop = my - Math.floor(groupH / 2);
        const by = groupTop + bIdx * (singleBarH + 1);
        const valCol = valueToCol(entry.data[i]!);
        const fromCol = Math.min(baseCol, valCol);
        const toCol = Math.max(baseCol, valCol);
        for (let r = by; r < by + singleBarH; r++) {
          for (let c = fromCol; c <= toCol; c++) {
            set(canvas, r, c, ch.bar);
          }
        }
      }
    }
  }
  const lineEntries: { data: number[] }[] = [];
  for (let si = 0; si < chart.series.length; si++) {
    if (chart.series[si]!.type === "line") lineEntries.push({ data: chart.series[si]!.data });
  }
  for (const entry of lineEntries) {
    if (entry.data.length === 0) continue;
    drawHorizontalStaircaseLine(
      canvas,
      entry.data,
      bandMid,
      valueToCol,
      plotTop,
      plotH,
      plotLeft,
      plotW,
      ch,
    );
  }
  return canvasToString(canvas);
}
function drawStaircaseLine(
  canvas: Canvas,
  data: number[],
  bandCenter: (i: number) => number,
  valueToRow: (v: number) => number,
  plotTop: number,
  plotH: number,
  plotLeft: number,
  plotTotalW: number,
  ch: typeof UNI | typeof ASC,
): void {
  if (data.length === 0) return;
  const points = data.map((v, i) => ({ col: bandCenter(i), row: valueToRow(v) }));
  const drawAt = (col: number, row: number, char: string) => {
    const displayRow = plotTop + (plotH - 1 - row);
    if (displayRow >= 0 && col >= plotLeft && col < plotLeft + plotTotalW) {
      set(canvas, displayRow, col, char);
    }
  };
  if (points.length === 1) {
    drawAt(points[0]!.col, points[0]!.row, ch.hLine);
    return;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    if (p1.row === p2.row) {
      for (let c = p1.col; c <= p2.col; c++) {
        drawAt(c, p1.row, ch.hLine);
      }
      continue;
    }
    const midCol = Math.round((p1.col + p2.col) / 2);
    const goingUp = p2.row > p1.row;
    for (let c = p1.col; c < midCol; c++) {
      drawAt(c, p1.row, ch.hLine);
    }
    if (goingUp) {
      drawAt(midCol, p1.row, ch.cornerBR);
    } else {
      drawAt(midCol, p1.row, ch.cornerTR);
    }
    const minRow = Math.min(p1.row, p2.row);
    const maxRow = Math.max(p1.row, p2.row);
    for (let row = minRow + 1; row < maxRow; row++) {
      drawAt(midCol, row, ch.vLine);
    }
    if (goingUp) {
      drawAt(midCol, p2.row, ch.cornerTL);
    } else {
      drawAt(midCol, p2.row, ch.cornerBL);
    }
    for (let c = midCol + 1; c <= p2.col; c++) {
      drawAt(c, p2.row, ch.hLine);
    }
    if (i === 0) {
      const leadStart = Math.max(plotLeft, p1.col - Math.floor((p2.col - p1.col) / 4));
      for (let c = leadStart; c < p1.col; c++) {
        drawAt(c, p1.row, ch.hLine);
      }
    }
    if (i === points.length - 2) {
      const trailEnd = Math.min(
        plotLeft + plotTotalW - 1,
        p2.col + Math.floor((p2.col - p1.col) / 4),
      );
      for (let c = p2.col + 1; c <= trailEnd; c++) {
        drawAt(c, p2.row, ch.hLine);
      }
    }
  }
}
function drawHorizontalStaircaseLine(
  canvas: Canvas,
  data: number[],
  bandMid: (i: number) => number,
  valueToCol: (v: number) => number,
  plotTop: number,
  plotH: number,
  plotLeft: number,
  plotW: number,
  ch: typeof UNI | typeof ASC,
): void {
  if (data.length === 0) return;
  const points = data.map((v, i) => ({ row: bandMid(i), col: valueToCol(v) }));
  const drawAt = (row: number, col: number, char: string) => {
    if (row >= plotTop && row < plotTop + plotH && col >= plotLeft && col < plotLeft + plotW) {
      set(canvas, row, col, char);
    }
  };
  if (points.length === 1) {
    drawAt(points[0]!.row, points[0]!.col, ch.vLine);
    return;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    if (p1.col === p2.col) {
      for (let r = p1.row; r <= p2.row; r++) {
        drawAt(r, p1.col, ch.vLine);
      }
      continue;
    }
    const midRow = Math.round((p1.row + p2.row) / 2);
    const goingRight = p2.col > p1.col;
    for (let r = p1.row; r < midRow; r++) {
      drawAt(r, p1.col, ch.vLine);
    }
    if (goingRight) {
      drawAt(midRow, p1.col, ch.cornerBL);
    } else {
      drawAt(midRow, p1.col, ch.cornerBR);
    }
    const minCol = Math.min(p1.col, p2.col);
    const maxCol = Math.max(p1.col, p2.col);
    for (let c = minCol + 1; c < maxCol; c++) {
      drawAt(midRow, c, ch.hLine);
    }
    if (goingRight) {
      drawAt(midRow, p2.col, ch.cornerTR);
    } else {
      drawAt(midRow, p2.col, ch.cornerTL);
    }
    for (let r = midRow + 1; r <= p2.row; r++) {
      drawAt(r, p2.col, ch.vLine);
    }
  }
}
function drawLegend(
  canvas: Canvas,
  chart: XYChart,
  row: number,
  totalW: number,
  ch: typeof UNI | typeof ASC,
): void {
  type LegendItem = { symbol: string; label: string };
  const items: LegendItem[] = [];
  let barIdx = 0,
    lineIdx = 0;
  for (let si = 0; si < chart.series.length; si++) {
    const s = chart.series[si]!;
    if (s.type === "bar") {
      items.push({ symbol: ch.bar, label: `Bar ${barIdx + 1}` });
      barIdx++;
    } else {
      items.push({ symbol: ch.hLine, label: `Line ${lineIdx + 1}` });
      lineIdx++;
    }
  }
  let totalLen = 0;
  for (let i = 0; i < items.length; i++) {
    if (i > 0) totalLen += 2;
    totalLen += 1 + 1 + items[i]!.label.length;
  }
  const startCol = Math.max(0, Math.floor(totalW / 2 - totalLen / 2));
  let col = startCol;
  for (let i = 0; i < items.length; i++) {
    if (i > 0) col += 2;
    const item = items[i]!;
    set(canvas, row, col, item.symbol);
    col += 1;
    col += 1;
    writeText(canvas, row, col, item.label);
    col += item.label.length;
  }
}
function createCanvas(width: number, height: number, budget?: RenderBudget): Canvas {
  validateCanvas(width, height);
  budget?.allocate(width, height);
  return Array.from({ length: width }, () => Array.from({ length: height }, () => " "));
}
function set(canvas: Canvas, row: number, col: number, char: string): void {
  if (col >= 0 && col < canvas.length && row >= 0 && row < canvas[0]!.length) {
    canvas[col]![row] = char;
  }
}
function get(canvas: Canvas, row: number, col: number): string {
  if (col >= 0 && col < canvas.length && row >= 0 && row < canvas[0]!.length) {
    return canvas[col]![row]!;
  }
  return " ";
}
function writeText(canvas: Canvas, row: number, startCol: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    set(canvas, row, startCol + i, text[i]!);
  }
}
function canvasToString(canvas: Canvas): string {
  if (canvas.length === 0) return "";
  const lines: string[] = [];
  for (let row = 0; row < canvas[0]!.length; row++) {
    let line = "";
    for (let col = 0; col < canvas.length; col++) line += canvas[col]![row]!;
    lines.push(line.replace(/ +$/, ""));
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}
function getDataCount(chart: XYChart): number {
  if (chart.xAxis.categories) return chart.xAxis.categories.length;
  for (const s of chart.series) {
    if (s.data.length > 0) return s.data.length;
  }
  return 0;
}
function getCategoryLabels(chart: XYChart, count: number): string[] {
  if (chart.xAxis.categories) return chart.xAxis.categories;
  if (chart.xAxis.range) {
    const { min, max } = chart.xAxis.range;
    const step = count > 1 ? (max - min) / (count - 1) : 0;
    return Array.from({ length: count }, (_, i) => formatTickValue(min + step * i));
  }
  return Array.from({ length: count }, (_, i) => String(i + 1));
}
function niceTickValues(min: number, max: number): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const rawInterval = range / 6;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawInterval)));
  const residual = rawInterval / magnitude;
  let niceInterval: number;
  if (residual <= 1.5) niceInterval = magnitude;
  else if (residual <= 3) niceInterval = 2 * magnitude;
  else if (residual <= 7) niceInterval = 5 * magnitude;
  else niceInterval = 10 * magnitude;
  if (!Number.isFinite(niceInterval) || niceInterval <= 0) {
    throw new RangeError("XY chart tick interval is outside the supported range");
  }
  const start = Math.ceil(min / niceInterval) * niceInterval;
  const ticks: number[] = [];
  for (let index = 0; index < 32; index++) {
    const value = start + index * niceInterval;
    if (value > max + niceInterval * 0.001) break;
    const rounded = Math.round(value * 1e10) / 1e10;
    ticks.push(Number.isFinite(rounded) ? rounded : value);
  }
  return ticks;
}
function formatTickValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) < 10 ? 1 : 0);
}
