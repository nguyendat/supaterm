export function detectDiagramType(
  text: string,
): "flowchart" | "sequence" | "class" | "er" | "xychart" {
  const firstLine = text.trim().split("\n")[0]?.trim().toLowerCase() ?? "";
  if (/^xychart(-beta)?\b/.test(firstLine)) return "xychart";
  if (/^sequencediagram\s*$/.test(firstLine)) return "sequence";
  if (/^classdiagram\s*$/.test(firstLine)) return "class";
  if (/^erdiagram\s*$/.test(firstLine)) return "er";
  return "flowchart";
}
