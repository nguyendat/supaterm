export const MERMAID_LIMITS = {
  sourceChars: 16_384,
  sourceLines: 512,
  lineChars: 2_048,
  nodes: 128,
  edges: 256,
  groups: 32,
  nesting: 16,
  padding: 20,
  canvasDimension: 2_048,
  canvasCells: 100_000,
  allocatedCells: 12_000_000,
  pathVisits: 20_000,
  totalPathVisits: 100_000,
  durationMs: 500,
} as const;

export const MERMAID_OUTPUT_CHARS = {
  ascii: MERMAID_LIMITS.canvasCells * 2 + MERMAID_LIMITS.canvasDimension,
  svg: 1_000_000,
} as const;
