import type { OrchestrationV2ThreadShell } from "@supaterm/contracts";
import type { PushNotificationKind, PushPreviewContent } from "@supaterm/contracts/push";

const labels: Record<PushNotificationKind, string> = {
  approval: "Approval needed",
  input: "Input needed",
  completion: "Thread completed",
  failure: "Thread failed",
  "usage-limit": "Usage limit reached",
};
const encoder = new TextEncoder();

function boundedText(input: string, budget: number): string {
  const clean = input
    .slice(0, 4096)
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  let result = "";
  let bytes = 0;
  for (const character of clean) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > budget) break;
    bytes += size;
    result += character;
  }
  return result;
}

export function pushPreviewContent(
  thread: Pick<OrchestrationV2ThreadShell, "title"> & {
    latestVisibleMessage: Pick<
      NonNullable<OrchestrationV2ThreadShell["latestVisibleMessage"]>,
      "role" | "text"
    > | null;
  },
  kind: PushNotificationKind,
): PushPreviewContent {
  const message = thread.latestVisibleMessage;
  const context = message?.role === "assistant" ? message.text.slice(0, 4000) : "";
  const title = boundedText(thread.title, 120) || "Supacode";
  let body = boundedText(`${labels[kind]}${context.trim() ? `: ${context}` : ""}`, 400);
  while (encoder.encode(JSON.stringify({ title, body })).byteLength > 768) {
    body = [...body].slice(0, -1).join("");
  }
  return { title, body };
}
