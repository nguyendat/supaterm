import type {
  XYChart,
  PositionedXYChart,
  PositionedAxis,
  AxisTick,
  PositionedBar,
  PositionedLine,
  GridLine,
  PlotArea,
  LegendItem,
} from "./types.ts";
import type { RenderOptions } from "../types.ts";
import { formatTickValue, getCategoryLabels, getDataCount, niceTickValues } from "./scale.ts";
import { estimateTextWidth } from "../styles.ts";
const XY = {
  plotWidth: 600,
  plotHeight: 340,
  padding: 22,
  titleFontSize: 18,
  titleFontWeight: 600,
  titleHeight: 42,
  axisLabelFontSize: 14,
  axisLabelFontWeight: 400,
  axisTitleFontSize: 15,
  axisTitleFontWeight: 500,
  xLabelHeight: 38,
  yLabelWidth: 58,
  yLabelGap: 18,
  axisTitlePad: 30,
  tickLength: 4,
  barPadRatio: 0.2,
  barGroupGap: 0,
  maxBarWidth: 40,
  legendFontSize: 14,
  legendFontWeight: 400,
  legendHeight: 28,
  legendSwatchW: 14,
  legendSwatchH: 14,
  legendGap: 6,
  legendItemGap: 16,
} as const;
export function layoutXYChart(chart: XYChart, _options: RenderOptions = {}): PositionedXYChart {
  if (chart.horizontal) return layoutHorizontal(chart);
  return layoutVertical(chart);
}
function layoutVertical(chart: XYChart): PositionedXYChart {
  const hasTitle = !!chart.title;
  const hasXTitle = !!chart.xAxis.title;
  const hasYTitle = !!chart.yAxis.title;
  const hasLegend = chart.series.length > 1;
  const yRange = chart.yAxis.range!;
  const yTicks = niceTickValues(yRange.min, yRange.max);
  const maxYLabelWidth = Math.max(
    ...yTicks.map((v) =>
      estimateTextWidth(formatTickValue(v), XY.axisLabelFontSize, XY.axisLabelFontWeight),
    ),
    XY.yLabelWidth,
  );
  const top = XY.padding + (hasTitle ? XY.titleHeight : 0) + (hasLegend ? XY.legendHeight : 0);
  const bottom = XY.padding + XY.xLabelHeight + (hasXTitle ? XY.axisTitlePad : 0);
  const left = XY.padding + maxYLabelWidth + XY.yLabelGap + (hasYTitle ? XY.axisTitlePad : 0);
  const right = XY.padding;
  const plotW = XY.plotWidth;
  const plotH = XY.plotHeight;
  const totalW = left + plotW + right;
  const totalH = top + plotH + bottom;
  const plotArea: PlotArea = { x: left, y: top, width: plotW, height: plotH };
  const dataCount = Math.max(1, getDataCount(chart));
  const xScale = (i: number) => left + (i + 0.5) * (plotW / dataCount);
  const bandWidth = plotW / dataCount;
  const yScale = (v: number) => {
    const t = (v - yRange.min) / (yRange.max - yRange.min || 1);
    return top + plotH - t * plotH;
  };
  const xTicks = buildXTicks(chart, xScale, top + plotH, bandWidth);
  const yAxisTicks: AxisTick[] = yTicks.map((v) => ({
    label: formatTickValue(v),
    x: left,
    y: yScale(v),
    tx: left - XY.tickLength,
    ty: yScale(v),
    labelX: left - XY.yLabelGap,
    labelY: yScale(v),
    textAnchor: "end" as const,
  }));
  const gridLines: GridLine[] = yTicks.map((v) => ({
    x1: left,
    y1: yScale(v),
    x2: left + plotW,
    y2: yScale(v),
  }));
  const catLabels = getCategoryLabels(chart, dataCount);
  const colorMap = chart.series.map((_, i) => i);
  const bars = layoutBars(chart, xScale, yScale, bandWidth, yRange.min, catLabels, colorMap);
  const lines = layoutLines(chart, xScale, yScale, catLabels, colorMap);
  const legendY = XY.padding + (hasTitle ? XY.titleHeight : 0) + XY.legendHeight / 2;
  const legend = hasLegend ? buildLegendItems(chart, totalW / 2, legendY, colorMap) : [];
  const xAxisLine = { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH };
  const yAxisLine = { x1: left, y1: top, x2: left, y2: top + plotH };
  const xAxisObj: PositionedAxis = {
    ticks: xTicks,
    line: xAxisLine,
    ...(hasXTitle
      ? { title: { text: chart.xAxis.title!, x: left + plotW / 2, y: totalH - XY.padding } }
      : {}),
  };
  const yAxisObj: PositionedAxis = {
    ticks: yAxisTicks,
    line: yAxisLine,
    ...(hasYTitle
      ? { title: { text: chart.yAxis.title!, x: XY.padding + 4, y: top + plotH / 2, rotate: -90 } }
      : {}),
  };
  const titleObj = hasTitle
    ? { text: chart.title!, x: totalW / 2, y: XY.padding + XY.titleFontSize }
    : undefined;
  return {
    width: totalW,
    height: totalH,
    title: titleObj,
    xAxis: xAxisObj,
    yAxis: yAxisObj,
    plotArea,
    bars,
    lines,
    gridLines,
    legend,
  };
}
function layoutHorizontal(chart: XYChart): PositionedXYChart {
  const hasTitle = !!chart.title;
  const hasXTitle = !!chart.xAxis.title;
  const hasYTitle = !!chart.yAxis.title;
  const hasLegend = chart.series.length > 1;
  const yRange = chart.yAxis.range!;
  const valueTicks = niceTickValues(yRange.min, yRange.max);
  const dataCount = Math.max(1, getDataCount(chart));
  const catLabels = getCategoryLabels(chart, dataCount);
  const maxCatLabelWidth = Math.max(
    ...catLabels.map((l) => estimateTextWidth(l, XY.axisLabelFontSize, XY.axisLabelFontWeight)),
    40,
  );
  const top = XY.padding + (hasTitle ? XY.titleHeight : 0) + (hasLegend ? XY.legendHeight : 0);
  const bottom = XY.padding + XY.xLabelHeight + (hasYTitle ? XY.axisTitlePad : 0);
  const left = XY.padding + maxCatLabelWidth + XY.yLabelGap + (hasXTitle ? XY.axisTitlePad : 0);
  const right = XY.padding;
  const plotW = XY.plotWidth;
  const plotH = XY.plotHeight;
  const totalW = left + plotW + right;
  const totalH = top + plotH + bottom;
  const plotArea: PlotArea = { x: left, y: top, width: plotW, height: plotH };
  const valueScale = (v: number) => {
    const t = (v - yRange.min) / (yRange.max - yRange.min || 1);
    return left + t * plotW;
  };
  const bandHeight = plotH / dataCount;
  const catScale = (i: number) => top + (i + 0.5) * bandHeight;
  const xTicks: AxisTick[] = valueTicks.map((v) => ({
    label: formatTickValue(v),
    x: valueScale(v),
    y: top + plotH,
    tx: valueScale(v),
    ty: top + plotH + XY.tickLength,
    labelX: valueScale(v),
    labelY: top + plotH + 18,
    textAnchor: "middle" as const,
  }));
  const yTicks: AxisTick[] = catLabels.map((label, i) => ({
    label,
    x: left,
    y: catScale(i),
    tx: left - XY.tickLength,
    ty: catScale(i),
    labelX: left - XY.yLabelGap,
    labelY: catScale(i),
    textAnchor: "end" as const,
  }));
  const gridLines: GridLine[] = valueTicks.map((v) => ({
    x1: valueScale(v),
    y1: top,
    x2: valueScale(v),
    y2: top + plotH,
  }));
  const colorMap = chart.series.map((_, i) => i);
  const barSeries = chart.series.filter((s) => s.type === "bar");
  const barCount = barSeries.length;
  const bars: PositionedBar[] = [];
  if (barCount > 0) {
    const usable = bandHeight * (1 - XY.barPadRatio);
    const rawBarH = barCount > 1 ? (usable - (barCount - 1) * XY.barGroupGap) / barCount : usable;
    const singleBarH = Math.min(rawBarH, XY.maxBarWidth);
    const groupH =
      barCount > 1 ? singleBarH * barCount + XY.barGroupGap * (barCount - 1) : singleBarH;
    let bIdx = 0;
    let seriesArrayIdx = 0;
    for (const s of chart.series) {
      if (s.type !== "bar") {
        seriesArrayIdx++;
        continue;
      }
      for (let i = 0; i < s.data.length; i++) {
        const cy = catScale(i);
        const groupTop = cy - groupH / 2;
        const by = groupTop + bIdx * (singleBarH + XY.barGroupGap);
        const valX = valueScale(Math.max(s.data[i]!, yRange.min));
        const baseX = valueScale(Math.max(0, yRange.min));
        bars.push({
          x: Math.min(baseX, valX),
          y: by,
          width: Math.abs(valX - baseX),
          height: singleBarH,
          value: s.data[i]!,
          label: catLabels[i]!,
          seriesIndex: bIdx,
          colorIndex: colorMap[seriesArrayIdx]!,
        });
      }
      bIdx++;
      seriesArrayIdx++;
    }
  }
  const lines: PositionedLine[] = [];
  let lineIdx = 0;
  let lineSeriesIdx = 0;
  for (const s of chart.series) {
    if (s.type !== "line") {
      lineSeriesIdx++;
      continue;
    }
    const points = s.data.map((v, i) => ({
      x: valueScale(v),
      y: catScale(i),
      value: v,
      label: catLabels[i]!,
    }));
    lines.push({ points, seriesIndex: lineIdx, colorIndex: colorMap[lineSeriesIdx]! });
    lineIdx++;
    lineSeriesIdx++;
  }
  const xAxisLine = { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH };
  const yAxisLine = { x1: left, y1: top, x2: left, y2: top + plotH };
  const xAxisObj: PositionedAxis = {
    ticks: xTicks,
    line: xAxisLine,
    ...(hasYTitle
      ? { title: { text: chart.yAxis.title!, x: left + plotW / 2, y: totalH - XY.padding } }
      : {}),
  };
  const yAxisObj: PositionedAxis = {
    ticks: yTicks,
    line: yAxisLine,
    ...(hasXTitle
      ? { title: { text: chart.xAxis.title!, x: XY.padding + 4, y: top + plotH / 2, rotate: -90 } }
      : {}),
  };
  const titleObj = hasTitle
    ? { text: chart.title!, x: totalW / 2, y: XY.padding + XY.titleFontSize }
    : undefined;
  const legendY = XY.padding + (hasTitle ? XY.titleHeight : 0) + XY.legendHeight / 2;
  const legend = hasLegend ? buildLegendItems(chart, totalW / 2, legendY, colorMap) : [];
  return {
    width: totalW,
    height: totalH,
    horizontal: true,
    title: titleObj,
    xAxis: xAxisObj,
    yAxis: yAxisObj,
    plotArea,
    bars,
    lines,
    gridLines,
    legend,
  };
}
function buildXTicks(
  chart: XYChart,
  xScale: (i: number) => number,
  axisY: number,
  _bandWidth: number,
): AxisTick[] {
  const count = Math.max(1, getDataCount(chart));
  const labels = getCategoryLabels(chart, count);
  return labels.map((label, i) => ({
    label,
    x: xScale(i),
    y: axisY,
    tx: xScale(i),
    ty: axisY + XY.tickLength,
    labelX: xScale(i),
    labelY: axisY + 18,
    textAnchor: "middle" as const,
  }));
}
function layoutBars(
  chart: XYChart,
  xScale: (i: number) => number,
  yScale: (v: number) => number,
  bandWidth: number,
  yMin: number,
  catLabels: string[],
  colorMap: number[],
): PositionedBar[] {
  const barSeries = chart.series.filter((s) => s.type === "bar");
  const barCount = barSeries.length;
  if (barCount === 0) return [];
  const usable = bandWidth * (1 - XY.barPadRatio);
  const rawBarW = barCount > 1 ? (usable - (barCount - 1) * XY.barGroupGap) / barCount : usable;
  const singleBarW = Math.min(rawBarW, XY.maxBarWidth);
  const groupW =
    barCount > 1 ? singleBarW * barCount + XY.barGroupGap * (barCount - 1) : singleBarW;
  const bars: PositionedBar[] = [];
  let bIdx = 0;
  let seriesArrayIdx = 0;
  for (const s of chart.series) {
    if (s.type !== "bar") {
      seriesArrayIdx++;
      continue;
    }
    for (let i = 0; i < s.data.length; i++) {
      const cx = xScale(i);
      const groupLeft = cx - groupW / 2;
      const bx = groupLeft + bIdx * (singleBarW + XY.barGroupGap);
      const valY = yScale(s.data[i]!);
      const baseY = yScale(Math.max(0, yMin));
      bars.push({
        x: bx,
        y: Math.min(valY, baseY),
        width: singleBarW,
        height: Math.abs(baseY - valY),
        value: s.data[i]!,
        label: catLabels[i]!,
        seriesIndex: bIdx,
        colorIndex: colorMap[seriesArrayIdx]!,
      });
    }
    bIdx++;
    seriesArrayIdx++;
  }
  return bars;
}
function layoutLines(
  chart: XYChart,
  xScale: (i: number) => number,
  yScale: (v: number) => number,
  catLabels: string[],
  colorMap: number[],
): PositionedLine[] {
  const lines: PositionedLine[] = [];
  let lineIdx = 0;
  let seriesArrayIdx = 0;
  for (const s of chart.series) {
    if (s.type !== "line") {
      seriesArrayIdx++;
      continue;
    }
    const points = s.data.map((v, i) => ({
      x: xScale(i),
      y: yScale(v),
      value: v,
      label: catLabels[i]!,
    }));
    lines.push({ points, seriesIndex: lineIdx, colorIndex: colorMap[seriesArrayIdx]! });
    lineIdx++;
    seriesArrayIdx++;
  }
  return lines;
}
function buildLegendItems(
  chart: XYChart,
  centerX: number,
  y: number,
  colorMap: number[],
): LegendItem[] {
  const items: LegendItem[] = [];
  let barIdx = 0,
    lineIdx = 0;
  for (let si = 0; si < chart.series.length; si++) {
    const s = chart.series[si]!;
    const label = s.type === "bar" ? `Bar ${barIdx + 1}` : `Line ${lineIdx + 1}`;
    items.push({
      label,
      x: 0,
      y,
      type: s.type,
      seriesIndex: s.type === "bar" ? barIdx : lineIdx,
      colorIndex: colorMap[si]!,
    });
    if (s.type === "bar") barIdx++;
    else lineIdx++;
  }
  const itemWidths = items.map((item) => {
    const textW = estimateTextWidth(item.label, XY.legendFontSize, XY.legendFontWeight);
    return XY.legendSwatchW + XY.legendGap + textW;
  });
  const totalWidth = itemWidths.reduce((a, b) => a + b, 0) + (items.length - 1) * XY.legendItemGap;
  let x = centerX - totalWidth / 2;
  for (let i = 0; i < items.length; i++) {
    items[i]!.x = x;
    x += itemWidths[i]! + XY.legendItemGap;
  }
  return items;
}
