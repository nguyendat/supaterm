import type { ShapeRenderer } from "./types.ts";
import { getBoxDimensions, renderBox, getBoxAttachmentPoint } from "./rectangle.ts";
import { getCorners } from "./corners.ts";
export const circleRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,
  render(label, dimensions, options) {
    const corners = getCorners("circle", options.useAscii);
    return renderBox(label, dimensions, corners, options.useAscii);
  },
  getAttachmentPoint: getBoxAttachmentPoint,
};
