import type { XYChart } from "./types.ts";
export function getDataCount(chart: XYChart): number {
  if (chart.xAxis.categories) return chart.xAxis.categories.length;
  for (const s of chart.series) {
    if (s.data.length > 0) return s.data.length;
  }
  return 0;
}
export function getCategoryLabels(chart: XYChart, count: number): string[] {
  if (chart.xAxis.categories) return chart.xAxis.categories;
  if (chart.xAxis.range) {
    const { min, max } = chart.xAxis.range;
    const step = count > 1 ? (max - min) / (count - 1) : 0;
    return Array.from({ length: count }, (_, i) => formatTickValue(min + step * i));
  }
  return Array.from({ length: count }, (_, i) => String(i + 1));
}
export function niceTickValues(min: number, max: number): number[] {
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
export function formatTickValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) < 10 ? 1 : 0);
}
