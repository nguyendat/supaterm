import type { Point, PositionedNode } from "./types.ts";
export function clipEdgeToShape(points: Point[], node: PositionedNode, isStart: boolean): Point[] {
  if (points.length < 2) return points;
  if (node.shape === "rectangle" || node.shape === "rounded" || node.shape === "stadium") {
    return points;
  }
  const result = [...points];
  if (node.shape === "diamond") {
    if (isStart) {
      result[0] = clipToDiamond(points[0]!, points[1]!, node);
    } else {
      const lastIdx = points.length - 1;
      result[lastIdx] = clipToDiamond(points[lastIdx]!, points[lastIdx - 1]!, node);
    }
  }
  return result;
}
function clipToDiamond(endpoint: Point, adjacent: Point, node: PositionedNode): Point {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const top: Point = { x: cx, y: node.y };
  const right: Point = { x: node.x + node.width, y: cy };
  const bottom: Point = { x: cx, y: node.y + node.height };
  const left: Point = { x: node.x, y: cy };
  const dx = endpoint.x - adjacent.x;
  const dy = endpoint.y - adjacent.y;
  const isVertical = Math.abs(dx) < Math.abs(dy);
  if (isVertical) {
    const rayX = endpoint.x;
    if (dy > 0) {
      if (rayX <= cx) {
        return intersectVerticalRayWithEdge(rayX, left, top) ?? top;
      } else {
        return intersectVerticalRayWithEdge(rayX, top, right) ?? top;
      }
    } else {
      if (rayX <= cx) {
        return intersectVerticalRayWithEdge(rayX, bottom, left) ?? bottom;
      } else {
        return intersectVerticalRayWithEdge(rayX, right, bottom) ?? bottom;
      }
    }
  } else {
    const rayY = endpoint.y;
    if (dx > 0) {
      if (rayY <= cy) {
        return intersectHorizontalRayWithEdge(rayY, top, left) ?? left;
      } else {
        return intersectHorizontalRayWithEdge(rayY, left, bottom) ?? left;
      }
    } else {
      if (rayY <= cy) {
        return intersectHorizontalRayWithEdge(rayY, top, right) ?? right;
      } else {
        return intersectHorizontalRayWithEdge(rayY, right, bottom) ?? right;
      }
    }
  }
}
function intersectHorizontalRayWithEdge(rayY: number, p1: Point, p2: Point): Point | null {
  const dy = p2.y - p1.y;
  if (Math.abs(dy) < 0.001) {
    return null;
  }
  const t = (rayY - p1.y) / dy;
  if (t < 0 || t > 1) {
    return null;
  }
  const x = p1.x + t * (p2.x - p1.x);
  return { x, y: rayY };
}
function intersectVerticalRayWithEdge(rayX: number, p1: Point, p2: Point): Point | null {
  const dx = p2.x - p1.x;
  if (Math.abs(dx) < 0.001) {
    return null;
  }
  const t = (rayX - p1.x) / dx;
  if (t < 0 || t > 1) {
    return null;
  }
  const y = p1.y + t * (p2.y - p1.y);
  return { x: rayX, y };
}
