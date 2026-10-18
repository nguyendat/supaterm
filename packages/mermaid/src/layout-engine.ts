import type { ElkNode, ElkExtendedEdge, LayoutOptions } from "elkjs";
import type {
  MermaidGraph,
  MermaidSubgraph,
  MermaidEdge,
  Direction,
  PositionedGraph,
  PositionedNode,
  PositionedEdge,
  PositionedGroup,
  Point,
  RenderOptions,
} from "./types.ts";
import { FONT_SIZES, FONT_WEIGHTS, NODE_PADDING, ARROW_HEAD } from "./styles.ts";
import { measureMultilineText } from "./text-metrics.ts";
import { elkLayoutSync } from "./elk-instance.ts";
import { clipEdgeToShape } from "./shape-clipping.ts";
const DEFAULTS = {
  font: "Inter",
  padding: 40,
  nodeSpacing: 28,
  layerSpacing: 48,
  mergeEdges: true,
  thoroughness: 3,
} as const;
function directionToElk(dir: MermaidGraph["direction"]): string {
  switch (dir) {
    case "LR":
      return "RIGHT";
    case "RL":
      return "LEFT";
    case "BT":
      return "UP";
    case "TD":
    case "TB":
    default:
      return "DOWN";
  }
}
function estimateNodeSize(
  id: string,
  label: string,
  shape: string,
): {
  width: number;
  height: number;
} {
  const metrics = measureMultilineText(label, FONT_SIZES.nodeLabel, FONT_WEIGHTS.nodeLabel);
  let width = metrics.width + NODE_PADDING.horizontal * 2;
  let height = metrics.height + NODE_PADDING.vertical * 2;
  if (shape === "diamond") {
    const side = Math.max(width, height) + NODE_PADDING.diamondExtra;
    width = side;
    height = side;
  }
  if (shape === "circle" || shape === "doublecircle") {
    const diameter = Math.ceil(Math.sqrt(width * width + height * height)) + 8;
    width = shape === "doublecircle" ? diameter + 12 : diameter;
    height = width;
  }
  if (shape === "hexagon") {
    width += NODE_PADDING.horizontal;
  }
  if (shape === "trapezoid" || shape === "trapezoid-alt") {
    width += NODE_PADDING.horizontal;
  }
  if (shape === "asymmetric") {
    width += 12;
  }
  if (shape === "cylinder") {
    height += 14;
  }
  if (shape === "state-start" || shape === "state-end") {
    return { width: 28, height: 28 };
  }
  width = Math.max(width, 60);
  height = Math.max(height, 36);
  return { width, height };
}
interface ElkGraphNode extends ElkNode {
  children?: ElkGraphNode[];
  edges?: ElkExtendedEdge[];
}
function mermaidToElk(
  graph: MermaidGraph,
  opts: Required<Pick<RenderOptions, "font" | "padding" | "nodeSpacing" | "layerSpacing">>,
): ElkGraphNode {
  const subgraphNodeIds = new Set<string>();
  const subgraphIds = new Set<string>();
  for (const sg of graph.subgraphs) {
    subgraphIds.add(sg.id);
    collectSubgraphNodeIds(sg, subgraphNodeIds, subgraphIds);
  }
  const nodeToSubgraph = buildNodeToSubgraphMap(graph.subgraphs);
  const edgesBySubgraph = new Map<
    string | null,
    Array<{
      index: number;
      edge: (typeof graph.edges)[0];
    }>
  >();
  edgesBySubgraph.set(null, []);
  const crossHierarchyEdges: Array<{
    index: number;
    edge: (typeof graph.edges)[0];
    sourceSubgraph: string | undefined;
    targetSubgraph: string | undefined;
  }> = [];
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i]!;
    const sourceSubgraph = nodeToSubgraph.get(edge.source);
    const targetSubgraph = nodeToSubgraph.get(edge.target);
    if (sourceSubgraph && sourceSubgraph === targetSubgraph) {
      if (!edgesBySubgraph.has(sourceSubgraph)) {
        edgesBySubgraph.set(sourceSubgraph, []);
      }
      edgesBySubgraph.get(sourceSubgraph)!.push({ index: i, edge });
    } else if (!sourceSubgraph && !targetSubgraph) {
      edgesBySubgraph.get(null)!.push({ index: i, edge });
    } else {
      crossHierarchyEdges.push({ index: i, edge, sourceSubgraph, targetSubgraph });
    }
  }
  const hasDirectionOverride = graph.subgraphs.some((sg) => sg.direction !== undefined);
  const elkGraph: ElkGraphNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": directionToElk(graph.direction),
      "elk.spacing.nodeNode": String(opts.nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(opts.layerSpacing),
      "elk.spacing.edgeEdge": "12",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
      "elk.layered.spacing.edgeNodeBetweenLayers": "12",
      "elk.padding": `[top=${opts.padding},left=${opts.padding},bottom=${opts.padding},right=${opts.padding}]`,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.contentAlignment": "H_CENTER V_CENTER",
      "elk.layered.thoroughness": String(DEFAULTS.thoroughness),
      "elk.layered.highDegreeNodes.treatment": "true",
      "elk.layered.highDegreeNodes.threshold": "8",
      "elk.layered.compaction.postCompaction.strategy": "LEFT_RIGHT_CONSTRAINT_LOCKING",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.wrapping.strategy": "OFF",
      "elk.hierarchyHandling": hasDirectionOverride ? "SEPARATE" : "INCLUDE_CHILDREN",
    },
    children: [],
    edges: [],
  };
  const subgraphPorts = new Map<
    string,
    Array<{
      portId: string;
      edgeIndex: number;
      direction: "incoming" | "outgoing";
      internalNodeId: string;
    }>
  >();
  if (hasDirectionOverride) {
    for (const { index, edge, sourceSubgraph, targetSubgraph } of crossHierarchyEdges) {
      if (sourceSubgraph) {
        const portId = `${sourceSubgraph}_out_${index}`;
        if (!subgraphPorts.has(sourceSubgraph)) {
          subgraphPorts.set(sourceSubgraph, []);
        }
        subgraphPorts.get(sourceSubgraph)!.push({
          portId,
          edgeIndex: index,
          direction: "outgoing",
          internalNodeId: edge.source,
        });
      }
      if (targetSubgraph) {
        const portId = `${targetSubgraph}_in_${index}`;
        if (!subgraphPorts.has(targetSubgraph)) {
          subgraphPorts.set(targetSubgraph, []);
        }
        subgraphPorts.get(targetSubgraph)!.push({
          portId,
          edgeIndex: index,
          direction: "incoming",
          internalNodeId: edge.target,
        });
      }
    }
  }
  for (const [id, node] of graph.nodes) {
    if (!subgraphNodeIds.has(id) && !subgraphIds.has(id)) {
      const size = estimateNodeSize(id, node.label, node.shape);
      elkGraph.children!.push({
        id,
        width: size.width,
        height: size.height,
        labels: [{ text: node.label }],
      });
    }
  }
  for (const sg of graph.subgraphs) {
    elkGraph.children!.push(subgraphToElk(sg, graph, opts, edgesBySubgraph, subgraphPorts));
  }
  for (const { index, edge } of edgesBySubgraph.get(null)!) {
    const elkEdge: ElkExtendedEdge = {
      id: `e${index}`,
      sources: [edge.source],
      targets: [edge.target],
    };
    if (edge.label) {
      const metrics = measureMultilineText(
        edge.label,
        FONT_SIZES.edgeLabel,
        FONT_WEIGHTS.edgeLabel,
      );
      elkEdge.labels = [
        {
          text: edge.label,
          width: metrics.width + 8,
          height: metrics.height + 6,
          layoutOptions: {
            "elk.edgeLabels.inline": "true",
            "elk.edgeLabels.placement": "CENTER",
          },
        },
      ];
    }
    elkGraph.edges!.push(elkEdge);
  }
  for (const { index, edge, sourceSubgraph, targetSubgraph } of crossHierarchyEdges) {
    const elkEdge: ElkExtendedEdge = {
      id: `e${index}`,
      sources:
        hasDirectionOverride && sourceSubgraph ? [`${sourceSubgraph}_out_${index}`] : [edge.source],
      targets:
        hasDirectionOverride && targetSubgraph ? [`${targetSubgraph}_in_${index}`] : [edge.target],
    };
    if (edge.label) {
      const metrics = measureMultilineText(
        edge.label,
        FONT_SIZES.edgeLabel,
        FONT_WEIGHTS.edgeLabel,
      );
      elkEdge.labels = [
        {
          text: edge.label,
          width: metrics.width + 8,
          height: metrics.height + 6,
          layoutOptions: {
            "elk.edgeLabels.inline": "true",
            "elk.edgeLabels.placement": "CENTER",
          },
        },
      ];
    }
    elkGraph.edges!.push(elkEdge);
  }
  return elkGraph;
}
function subgraphToElk(
  sg: MermaidSubgraph,
  graph: MermaidGraph,
  opts: Required<Pick<RenderOptions, "font" | "padding" | "nodeSpacing" | "layerSpacing">>,
  edgesBySubgraph: Map<
    string | null,
    Array<{
      index: number;
      edge: MermaidEdge;
    }>
  >,
  subgraphPorts: Map<
    string,
    Array<{
      portId: string;
      edgeIndex: number;
      direction: "incoming" | "outgoing";
      internalNodeId: string;
    }>
  >,
): ElkGraphNode {
  const layoutOptions: LayoutOptions = {
    "elk.algorithm": "layered",
    "elk.padding": "[top=44,left=16,bottom=16,right=16]",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.contentAlignment": "H_CENTER V_CENTER",
    "elk.spacing.edgeEdge": "12",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
    "elk.layered.spacing.edgeNodeBetweenLayers": "12",
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
    "elk.layered.spacing.nodeNodeBetweenLayers": String(opts.layerSpacing),
    "elk.spacing.nodeNode": String(opts.nodeSpacing),
  };
  if (sg.direction) {
    layoutOptions["elk.direction"] = directionToElk(sg.direction);
  }
  const elkNode: ElkGraphNode = {
    id: sg.id,
    layoutOptions,
    ...(sg.label ? { labels: [{ text: sg.label }] } : {}),
    children: [],
    edges: [],
  };
  const ports = subgraphPorts.get(sg.id) ?? [];
  if (ports.length > 0) {
    (elkNode as unknown as Record<string, unknown>).ports = ports.map((p) => ({
      id: p.portId,
    }));
  }
  for (const nodeId of sg.nodeIds) {
    const node = graph.nodes.get(nodeId);
    if (node) {
      const size = estimateNodeSize(nodeId, node.label, node.shape);
      elkNode.children!.push({
        id: nodeId,
        width: size.width,
        height: size.height,
        labels: [{ text: node.label }],
      });
    }
  }
  for (const child of sg.children) {
    elkNode.children!.push(subgraphToElk(child, graph, opts, edgesBySubgraph, subgraphPorts));
  }
  const internalEdges = edgesBySubgraph.get(sg.id) ?? [];
  for (const { index, edge } of internalEdges) {
    const elkEdge: ElkExtendedEdge = {
      id: `e${index}`,
      sources: [edge.source],
      targets: [edge.target],
    };
    if (edge.label) {
      const metrics = measureMultilineText(
        edge.label,
        FONT_SIZES.edgeLabel,
        FONT_WEIGHTS.edgeLabel,
      );
      elkEdge.labels = [
        {
          text: edge.label,
          width: metrics.width + 8,
          height: metrics.height + 6,
          layoutOptions: {
            "elk.edgeLabels.inline": "true",
            "elk.edgeLabels.placement": "CENTER",
          },
        },
      ];
    }
    elkNode.edges!.push(elkEdge);
  }
  for (const port of ports) {
    const internalEdgeId = `e${port.edgeIndex}_internal`;
    const elkEdge: ElkExtendedEdge =
      port.direction === "incoming"
        ? { id: internalEdgeId, sources: [port.portId], targets: [port.internalNodeId] }
        : { id: internalEdgeId, sources: [port.internalNodeId], targets: [port.portId] };
    elkNode.edges!.push(elkEdge);
  }
  return elkNode;
}
function collectSubgraphNodeIds(
  sg: MermaidSubgraph,
  nodeIds: Set<string>,
  subgraphIds: Set<string>,
): void {
  for (const id of sg.nodeIds) {
    nodeIds.add(id);
  }
  for (const child of sg.children) {
    subgraphIds.add(child.id);
    collectSubgraphNodeIds(child, nodeIds, subgraphIds);
  }
}
function buildNodeToSubgraphMap(subgraphs: MermaidSubgraph[]): Map<string, string> {
  const map = new Map<string, string>();
  function traverse(sg: MermaidSubgraph): void {
    for (const nodeId of sg.nodeIds) {
      map.set(nodeId, sg.id);
    }
    for (const child of sg.children) {
      traverse(child);
    }
  }
  for (const sg of subgraphs) {
    traverse(sg);
  }
  return map;
}
interface MarginInfo {
  leftX: number;
  rightX: number;
}
function flattenGroupBounds(groups: PositionedGroup[]): Array<{
  x: number;
  y: number;
  right: number;
  bottom: number;
}> {
  const bounds: Array<{
    x: number;
    y: number;
    right: number;
    bottom: number;
  }> = [];
  for (const g of groups) {
    bounds.push({ x: g.x, y: g.y, right: g.x + g.width, bottom: g.y + g.height });
    bounds.push(...flattenGroupBounds(g.children));
  }
  return bounds;
}
function elkToPositioned(
  elkResult: ElkNode,
  graph: MermaidGraph,
  mergeEdges: boolean = false,
): PositionedGraph {
  const nodes: PositionedNode[] = [];
  const edges: PositionedEdge[] = [];
  const groups: PositionedGroup[] = [];
  const subgraphIds = new Set<string>();
  for (const sg of graph.subgraphs) {
    collectAllSubgraphIds(sg, subgraphIds);
  }
  extractNodesAndGroups(elkResult, graph, subgraphIds, nodes, groups, 0, 0);
  const allBounds = flattenGroupBounds(groups);
  const margins: MarginInfo | undefined =
    allBounds.length > 0
      ? {
          leftX: Math.min(...allBounds.map((b) => b.x)) - 20,
          rightX: Math.max(...allBounds.map((b) => b.right)) + 20,
        }
      : undefined;
  extractEdgesRecursively(elkResult, graph, edges, 0, 0, margins);
  alignLayerNodes(nodes, edges, graph.direction);
  if (mergeEdges) {
    bundleEdgePaths(edges, nodes, groups, graph.direction);
  }
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    if (sourceNode) {
      edge.points = clipEdgeToShape(edge.points, sourceNode, true);
    }
    if (targetNode) {
      edge.points = clipEdgeToShape(edge.points, targetNode, false);
    }
  }
  let width = elkResult.width ?? 800;
  let height = elkResult.height ?? 600;
  const arrowMargin = ARROW_HEAD.width;
  const padding = DEFAULTS.padding;
  for (const edge of edges) {
    for (const p of edge.points) {
      width = Math.max(width, p.x + arrowMargin + padding);
      height = Math.max(height, p.y + arrowMargin + padding);
    }
    if (edge.labelPosition) {
      width = Math.max(width, edge.labelPosition.x + 60 + padding);
      height = Math.max(height, edge.labelPosition.y + 20 + padding);
    }
  }
  return {
    width,
    height,
    nodes,
    edges,
    groups,
  };
}
function extractNodesAndGroups(
  elkNode: ElkNode,
  graph: MermaidGraph,
  subgraphIds: Set<string>,
  nodes: PositionedNode[],
  groups: PositionedGroup[],
  offsetX: number,
  offsetY: number,
): void {
  if (!elkNode.children) return;
  for (const child of elkNode.children) {
    const x = (child.x ?? 0) + offsetX;
    const y = (child.y ?? 0) + offsetY;
    const width = child.width ?? 0;
    const height = child.height ?? 0;
    if (subgraphIds.has(child.id)) {
      const childGroups: PositionedGroup[] = [];
      extractNodesAndGroups(child, graph, subgraphIds, nodes, childGroups, x, y);
      const mermaidSg = findSubgraph(graph.subgraphs, child.id);
      groups.push({
        id: child.id,
        label: mermaidSg?.label ?? "",
        x,
        y,
        width,
        height,
        children: childGroups,
      });
    } else {
      const mNode = graph.nodes.get(child.id);
      if (mNode) {
        const inlineStyle = resolveNodeStyle(child.id, graph);
        nodes.push({
          id: child.id,
          label: mNode.label,
          shape: mNode.shape,
          x,
          y,
          width,
          height,
          inlineStyle,
        });
      }
      if (child.children && child.children.length > 0) {
        extractNodesAndGroups(child, graph, subgraphIds, nodes, groups, x, y);
      }
    }
  }
}
interface EdgeSegment {
  edgeIndex: number;
  isInternal: boolean;
  points: Point[];
  labelPosition?: Point | undefined;
}
function calculatePathMidpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    totalLength += Math.sqrt(dx * dx + dy * dy);
  }
  let remaining = totalLength / 2;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (remaining <= segLen) {
      const t = remaining / segLen;
      return {
        x: points[i - 1]!.x + t * dx,
        y: points[i - 1]!.y + t * dy,
      };
    }
    remaining -= segLen;
  }
  return points[points.length - 1]!;
}
function extractEdgesRecursively(
  elkNode: ElkNode,
  graph: MermaidGraph,
  edges: PositionedEdge[],
  offsetX: number,
  offsetY: number,
  margins?: MarginInfo,
): void {
  const segments = new Map<
    number,
    {
      external?: EdgeSegment;
      incoming?: EdgeSegment;
      outgoing?: EdgeSegment;
    }
  >();
  collectEdgeSegments(elkNode, segments, 0, 0);
  let marginEdgeIndex = 0;
  for (const [edgeIndex, seg] of segments) {
    const originalEdge = graph.edges[edgeIndex];
    if (!originalEdge) continue;
    const allPoints: Point[] = [];
    if (seg.outgoing && seg.outgoing.points.length > 0) {
      allPoints.push(...seg.outgoing.points);
    }
    if (seg.external && seg.external.points.length > 0) {
      if (allPoints.length > 0) {
        allPoints.push(...seg.external.points.slice(1));
      } else {
        allPoints.push(...seg.external.points);
      }
    }
    if (seg.incoming && seg.incoming.points.length > 0) {
      if (allPoints.length > 0) {
        allPoints.push(...seg.incoming.points.slice(1));
      } else {
        allPoints.push(...seg.incoming.points);
      }
    }
    let labelPosition: Point | undefined;
    if (originalEdge.label && allPoints.length >= 2) {
      const elkLabelPos = seg.external?.labelPosition;
      labelPosition = elkLabelPos ?? calculatePathMidpoint(allPoints);
    }
    const orthogonalPoints = orthogonalizeEdgePoints(allPoints, margins, marginEdgeIndex);
    if (orthogonalPoints !== allPoints) {
      marginEdgeIndex++;
    }
    if (originalEdge.label && orthogonalPoints !== allPoints && orthogonalPoints.length >= 2) {
      labelPosition = calculatePathMidpoint(orthogonalPoints);
    }
    edges.push({
      source: originalEdge.source,
      target: originalEdge.target,
      label: originalEdge.label,
      style: originalEdge.style,
      hasArrowStart: originalEdge.hasArrowStart,
      hasArrowEnd: originalEdge.hasArrowEnd,
      points: orthogonalPoints,
      labelPosition,
      inlineStyle: resolveEdgeStyle(edgeIndex, graph),
    });
  }
}
function orthogonalizeEdgePoints(
  points: Point[],
  margins?: MarginInfo,
  edgeIndex: number = 0,
): Point[] {
  if (points.length < 2) return points;
  let needsWork = false;
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i]!.x - points[i - 1]!.x);
    const dy = Math.abs(points[i]!.y - points[i - 1]!.y);
    if (dx > 1 && dy > 1) {
      needsWork = true;
      break;
    }
  }
  if (!needsWork) return points;
  const EDGE_SPACING = 12;
  const result: Point[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1]!;
    const curr = points[i]!;
    const dx = Math.abs(curr.x - prev.x);
    const dy = Math.abs(curr.y - prev.y);
    if (dx > 1 && dy > 1) {
      if (margins) {
        const useRight = edgeIndex % 2 === 0;
        const offset = Math.floor(edgeIndex / 2) * EDGE_SPACING;
        const marginX = useRight ? margins.rightX + offset : margins.leftX - offset;
        result.push({ x: marginX, y: prev.y });
        result.push({ x: marginX, y: curr.y });
      } else {
        const midY = (prev.y + curr.y) / 2;
        result.push({ x: prev.x, y: midY });
        result.push({ x: curr.x, y: midY });
      }
    }
    result.push(curr);
  }
  return result;
}
function collectEdgeSegments(
  elkNode: ElkNode,
  segments: Map<
    number,
    {
      external?: EdgeSegment;
      incoming?: EdgeSegment;
      outgoing?: EdgeSegment;
    }
  >,
  offsetX: number,
  offsetY: number,
): void {
  if (elkNode.edges) {
    for (const elkEdge of elkNode.edges) {
      const isInternal = elkEdge.id.endsWith("_internal");
      const edgeIndex = parseInt(elkEdge.id.substring(1), 10);
      if (isNaN(edgeIndex)) continue;
      const points: Point[] = [];
      if (elkEdge.sections && elkEdge.sections.length > 0) {
        const section = elkEdge.sections[0]!;
        points.push({
          x: section.startPoint.x + offsetX,
          y: section.startPoint.y + offsetY,
        });
        if (section.bendPoints) {
          for (const bp of section.bendPoints) {
            points.push({ x: bp.x + offsetX, y: bp.y + offsetY });
          }
        }
        points.push({
          x: section.endPoint.x + offsetX,
          y: section.endPoint.y + offsetY,
        });
      }
      let labelPosition: Point | undefined;
      if (elkEdge.labels && elkEdge.labels.length > 0) {
        const label = elkEdge.labels[0]!;
        if (label.x != null && label.y != null) {
          labelPosition = {
            x: label.x + (label.width ?? 0) / 2 + offsetX,
            y: label.y + (label.height ?? 0) / 2 + offsetY,
          };
        }
      }
      if (!segments.has(edgeIndex)) {
        segments.set(edgeIndex, {});
      }
      const seg = segments.get(edgeIndex)!;
      if (isInternal) {
        const source = elkEdge.sources?.[0] ?? "";
        const target = elkEdge.targets?.[0] ?? "";
        const sourceIsPort = source.includes("_in_") || source.includes("_out_");
        const targetIsPort = target.includes("_in_") || target.includes("_out_");
        if (sourceIsPort) {
          seg.incoming = { edgeIndex, isInternal, points, labelPosition };
        } else if (targetIsPort) {
          seg.outgoing = { edgeIndex, isInternal, points, labelPosition };
        }
      } else {
        seg.external = { edgeIndex, isInternal, points, labelPosition };
      }
    }
  }
  if (elkNode.children) {
    for (const child of elkNode.children) {
      collectEdgeSegments(child, segments, offsetX + (child.x ?? 0), offsetY + (child.y ?? 0));
    }
  }
}
function findSubgraph(subgraphs: MermaidSubgraph[], id: string): MermaidSubgraph | undefined {
  for (const sg of subgraphs) {
    if (sg.id === id) return sg;
    const found = findSubgraph(sg.children, id);
    if (found) return found;
  }
  return undefined;
}
function collectAllSubgraphIds(sg: MermaidSubgraph, out: Set<string>): void {
  out.add(sg.id);
  for (const child of sg.children) {
    collectAllSubgraphIds(child, out);
  }
}
function resolveNodeStyle(nodeId: string, graph: MermaidGraph): Record<string, string> | undefined {
  let result: Record<string, string> | undefined;
  const className = graph.classAssignments.get(nodeId);
  if (className) {
    const classDef = graph.classDefs.get(className);
    if (classDef) {
      result = { ...classDef };
    }
  }
  const nodeStyle = graph.nodeStyles.get(nodeId);
  if (nodeStyle) {
    result = result ? { ...result, ...nodeStyle } : { ...nodeStyle };
  }
  return result;
}
function resolveEdgeStyle(
  edgeIndex: number,
  graph: MermaidGraph,
): Record<string, string> | undefined {
  let result: Record<string, string> | undefined;
  const defaultStyle = graph.linkStyles.get("default");
  if (defaultStyle) {
    result = { ...defaultStyle };
  }
  const indexStyle = graph.linkStyles.get(edgeIndex);
  if (indexStyle) {
    result = result ? { ...result, ...indexStyle } : { ...indexStyle };
  }
  return result;
}
function alignLayerNodes(
  nodes: PositionedNode[],
  edges: PositionedEdge[],
  direction: Direction,
): void {
  if (nodes.length === 0) return;
  const isHorizontal = direction === "LR" || direction === "RL";
  const connectedPairs = new Set<string>();
  for (const edge of edges) {
    connectedPairs.add(`${edge.source}:${edge.target}`);
    connectedPairs.add(`${edge.target}:${edge.source}`);
  }
  const THRESHOLD = DEFAULTS.layerSpacing * 0.6;
  const sorted = [...nodes].sort((a, b) => (isHorizontal ? a.x - b.x : a.y - b.y));
  const layers: PositionedNode[][] = [];
  let currentLayer: PositionedNode[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const pos = isHorizontal ? sorted[i]!.x : sorted[i]!.y;
    const prevPos = isHorizontal ? sorted[i - 1]!.x : sorted[i - 1]!.y;
    const gap = pos - prevPos;
    const hasEdgeToLayer = currentLayer.some((n) => connectedPairs.has(`${n.id}:${sorted[i]!.id}`));
    if (gap <= THRESHOLD && !hasEdgeToLayer) {
      currentLayer.push(sorted[i]!);
    } else {
      layers.push(currentLayer);
      currentLayer = [sorted[i]!];
    }
  }
  layers.push(currentLayer);
  const deltas = new Map<string, number>();
  for (const layer of layers) {
    if (layer.length <= 1) continue;
    const positions = layer.map((n) => (isHorizontal ? n.x : n.y));
    const min = Math.min(...positions);
    const max = Math.max(...positions);
    if (max - min <= 1) continue;
    const target = (min + max) / 2;
    for (const node of layer) {
      const oldPos = isHorizontal ? node.x : node.y;
      const delta = target - oldPos;
      if (Math.abs(delta) > 0.5) {
        if (isHorizontal) {
          node.x = target;
        } else {
          node.y = target;
        }
        deltas.set(node.id, delta);
      }
    }
  }
  if (deltas.size === 0) return;
  for (const edge of edges) {
    if (edge.points.length < 2) continue;
    const srcDelta = deltas.get(edge.source);
    const tgtDelta = deltas.get(edge.target);
    if (srcDelta != null) {
      const first = edge.points[0]!;
      if (isHorizontal) {
        first.x += srcDelta;
        if (edge.points.length > 1 && edge.points[1]!.x === first.x - srcDelta) {
          edge.points[1]!.x += srcDelta;
        }
      } else {
        first.y += srcDelta;
        if (edge.points.length > 1 && edge.points[1]!.y === first.y - srcDelta) {
          edge.points[1]!.y += srcDelta;
        }
      }
    }
    if (tgtDelta != null) {
      const last = edge.points[edge.points.length - 1]!;
      if (isHorizontal) {
        last.x += tgtDelta;
        if (edge.points.length > 1) {
          const prev = edge.points[edge.points.length - 2]!;
          if (prev.x === last.x - tgtDelta) prev.x += tgtDelta;
        }
      } else {
        last.y += tgtDelta;
        if (edge.points.length > 1) {
          const prev = edge.points[edge.points.length - 2]!;
          if (prev.y === last.y - tgtDelta) prev.y += tgtDelta;
        }
      }
    }
  }
}
function findGroupsContainingPoint(
  x: number,
  y: number,
  groups: PositionedGroup[],
): PositionedGroup[] {
  const result: PositionedGroup[] = [];
  for (const g of groups) {
    if (x >= g.x && x <= g.x + g.width && y >= g.y && y <= g.y + g.height) {
      result.push(g);
      result.push(...findGroupsContainingPoint(x, y, g.children));
    }
  }
  return result;
}
function adjustJunctionForGroups(
  junctionMain: number,
  refX: number,
  refY: number,
  groups: PositionedGroup[],
  direction: Direction,
): number {
  const GAP = 12;
  const isLR = direction === "LR";
  const isRL = direction === "RL";
  const isBT = direction === "BT";
  const isHorizontal = isLR || isRL;
  const refGroupIds = new Set(findGroupsContainingPoint(refX, refY, groups).map((g) => g.id));
  const probeX = isHorizontal ? junctionMain : refX;
  const probeY = isHorizontal ? refY : junctionMain;
  const junctionGroups = findGroupsContainingPoint(probeX, probeY, groups);
  const crossingGroup = junctionGroups.find((g) => !refGroupIds.has(g.id));
  if (!crossingGroup) return junctionMain;
  if (isLR) return crossingGroup.x - GAP;
  if (isRL) return crossingGroup.x + crossingGroup.width + GAP;
  if (isBT) return crossingGroup.y + crossingGroup.height + GAP;
  return crossingGroup.y - GAP;
}
function bundleEdgePaths(
  edges: PositionedEdge[],
  nodes: PositionedNode[],
  groups: PositionedGroup[],
  direction: Direction,
): void {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const processed = new Set<PositionedEdge>();
  const isLR = direction === "LR";
  const isRL = direction === "RL";
  const isBT = direction === "BT";
  const isHorizontal = isLR || isRL;
  const fanOutGroups = new Map<string, PositionedEdge[]>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!fanOutGroups.has(edge.source)) fanOutGroups.set(edge.source, []);
    fanOutGroups.get(edge.source)!.push(edge);
  }
  for (const [sourceId, group] of fanOutGroups) {
    if (group.length < 2) continue;
    const style = group[0]!.style;
    if (group.some((e) => e.label || e.style !== style)) continue;
    const source = nodeMap.get(sourceId);
    if (!source) continue;
    const forward = group.filter((e) => {
      const t = nodeMap.get(e.target);
      if (!t) return false;
      if (isLR) return t.x > source.x + source.width;
      if (isRL) return t.x + t.width < source.x;
      if (isBT) return t.y + t.height < source.y;
      return t.y > source.y + source.height;
    });
    if (forward.length < 2) continue;
    const targets = forward.map((e) => ({ edge: e, node: nodeMap.get(e.target)! }));
    const srcCX = source.x + source.width / 2;
    const srcCY = source.y + source.height / 2;
    if (isHorizontal) {
      const exitX = isLR ? source.x + source.width : source.x;
      const exitY = srcCY;
      const nearestX = isLR
        ? Math.min(...targets.map((t) => t.node.x))
        : Math.max(...targets.map((t) => t.node.x + t.node.width));
      let junctionX = exitX + (nearestX - exitX) / 2;
      junctionX = adjustJunctionForGroups(junctionX, srcCX, srcCY, groups, direction);
      for (const { edge, node: target } of targets) {
        const entryX = isLR ? target.x : target.x + target.width;
        const entryY = target.y + target.height / 2;
        edge.points = [
          { x: exitX, y: exitY },
          { x: junctionX, y: exitY },
          { x: junctionX, y: entryY },
          { x: entryX, y: entryY },
        ];
        processed.add(edge);
      }
    } else {
      const exitX = srcCX;
      const exitY = isBT ? source.y : source.y + source.height;
      const nearestY = isBT
        ? Math.max(...targets.map((t) => t.node.y + t.node.height))
        : Math.min(...targets.map((t) => t.node.y));
      let junctionY = exitY + (nearestY - exitY) / 2;
      junctionY = adjustJunctionForGroups(junctionY, srcCX, srcCY, groups, direction);
      for (const { edge, node: target } of targets) {
        const entryX = target.x + target.width / 2;
        const entryY = isBT ? target.y + target.height : target.y;
        edge.points = [
          { x: exitX, y: exitY },
          { x: exitX, y: junctionY },
          { x: entryX, y: junctionY },
          { x: entryX, y: entryY },
        ];
        processed.add(edge);
      }
    }
  }
  const fanInGroups = new Map<string, PositionedEdge[]>();
  for (const edge of edges) {
    if (processed.has(edge) || edge.source === edge.target) continue;
    if (!fanInGroups.has(edge.target)) fanInGroups.set(edge.target, []);
    fanInGroups.get(edge.target)!.push(edge);
  }
  for (const [targetId, group] of fanInGroups) {
    if (group.length < 2) continue;
    const style = group[0]!.style;
    if (group.some((e) => e.label || e.style !== style)) continue;
    const target = nodeMap.get(targetId);
    if (!target) continue;
    const forward = group.filter((e) => {
      const s = nodeMap.get(e.source);
      if (!s) return false;
      if (isLR) return s.x + s.width < target.x;
      if (isRL) return s.x > target.x + target.width;
      if (isBT) return s.y > target.y + target.height;
      return s.y + s.height < target.y;
    });
    if (forward.length < 2) continue;
    const sources = forward.map((e) => ({ edge: e, node: nodeMap.get(e.source)! }));
    const tgtCX = target.x + target.width / 2;
    const tgtCY = target.y + target.height / 2;
    if (isHorizontal) {
      const entryX = isLR ? target.x : target.x + target.width;
      const entryY = tgtCY;
      const farthestX = isLR
        ? Math.max(...sources.map((s) => s.node.x + s.node.width))
        : Math.min(...sources.map((s) => s.node.x));
      let junctionX = farthestX + (entryX - farthestX) / 2;
      junctionX = adjustJunctionForGroups(junctionX, tgtCX, tgtCY, groups, direction);
      for (const { edge, node: src } of sources) {
        const exitX = isLR ? src.x + src.width : src.x;
        const exitY = src.y + src.height / 2;
        edge.points = [
          { x: exitX, y: exitY },
          { x: junctionX, y: exitY },
          { x: junctionX, y: entryY },
          { x: entryX, y: entryY },
        ];
      }
    } else {
      const entryX = tgtCX;
      const entryY = isBT ? target.y + target.height : target.y;
      const farthestY = isBT
        ? Math.min(...sources.map((s) => s.node.y))
        : Math.max(...sources.map((s) => s.node.y + s.node.height));
      let junctionY = farthestY + (entryY - farthestY) / 2;
      junctionY = adjustJunctionForGroups(junctionY, tgtCX, tgtCY, groups, direction);
      for (const { edge, node: src } of sources) {
        const exitX = src.x + src.width / 2;
        const exitY = isBT ? src.y : src.y + src.height;
        edge.points = [
          { x: exitX, y: exitY },
          { x: exitX, y: junctionY },
          { x: entryX, y: junctionY },
          { x: entryX, y: entryY },
        ];
      }
    }
  }
}
export function layoutGraphSync(graph: MermaidGraph, options: RenderOptions = {}): PositionedGraph {
  const opts = { ...DEFAULTS, ...options };
  const elkGraph = mermaidToElk(graph, opts);
  const result = elkLayoutSync(elkGraph);
  return elkToPositioned(result, graph, DEFAULTS.mergeEdges);
}
export function convertToElkFormat(graph: MermaidGraph, options: RenderOptions = {}): ElkNode {
  const opts = { ...DEFAULTS, ...options };
  return mermaidToElk(graph, opts);
}
