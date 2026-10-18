import type { AsciiNodeShape, Canvas, DrawingCoord, Direction } from "../types.ts";
import type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions, ShapeRegistry } from "./types.ts";
import { rectangleRenderer } from "./rectangle.ts";
import { diamondRenderer } from "./diamond.ts";
import { circleRenderer } from "./circle.ts";
import { stateStartRenderer, stateEndRenderer } from "./state.ts";
import { roundedRenderer } from "./rounded.ts";
import { stadiumRenderer } from "./stadium.ts";
import { hexagonRenderer } from "./hexagon.ts";
import {
  subroutineRenderer,
  doublecircleRenderer,
  cylinderRenderer,
  asymmetricRenderer,
  trapezoidRenderer,
  trapezoidAltRenderer,
} from "./special.ts";
export type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions, ShapeRegistry };
export const shapeRegistry: ShapeRegistry = new Map<AsciiNodeShape, ShapeRenderer>([
  ["rectangle", rectangleRenderer],
  ["rounded", roundedRenderer],
  ["diamond", diamondRenderer],
  ["stadium", stadiumRenderer],
  ["circle", circleRenderer],
  ["subroutine", subroutineRenderer],
  ["doublecircle", doublecircleRenderer],
  ["hexagon", hexagonRenderer],
  ["cylinder", cylinderRenderer],
  ["asymmetric", asymmetricRenderer],
  ["trapezoid", trapezoidRenderer],
  ["trapezoid-alt", trapezoidAltRenderer],
  ["state-start", stateStartRenderer],
  ["state-end", stateEndRenderer],
]);
export function getShapeRenderer(shape: AsciiNodeShape): ShapeRenderer {
  return shapeRegistry.get(shape) ?? rectangleRenderer;
}
export function renderShape(
  shape: AsciiNodeShape,
  label: string,
  options: ShapeRenderOptions,
): Canvas {
  const renderer = getShapeRenderer(shape);
  const dimensions = renderer.getDimensions(label, options);
  return renderer.render(label, dimensions, options);
}
export function getShapeDimensions(
  shape: AsciiNodeShape,
  label: string,
  options: ShapeRenderOptions,
): ShapeDimensions {
  const renderer = getShapeRenderer(shape);
  return renderer.getDimensions(label, options);
}
export function getShapeAttachmentPoint(
  shape: AsciiNodeShape,
  dir: Direction,
  dimensions: ShapeDimensions,
  baseCoord: DrawingCoord,
): DrawingCoord {
  const renderer = getShapeRenderer(shape);
  return renderer.getAttachmentPoint(dir, dimensions, baseCoord);
}
