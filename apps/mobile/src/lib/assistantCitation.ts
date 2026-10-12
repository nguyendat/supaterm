import { ASSISTANT_CITATION_MAX_TEXT_LENGTH, type AssistantCitation } from "@supacode/contracts";
import { createAssistantTextSelector } from "@supacode/shared/assistantCitations";
import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";

function renderedMarkdownText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "code" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return "\n";
  if (!("children" in node)) return "";
  const inline =
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "emphasis" ||
    node.type === "strong" ||
    node.type === "delete" ||
    node.type === "link" ||
    node.type === "linkReference" ||
    node.type === "tableCell";
  return node.children.map(renderedMarkdownText).join(inline ? "" : "\n");
}

export function captureAssistantCitation(
  source: Pick<AssistantCitation, "environmentId" | "threadId" | "messageId"> & {
    markdown: string;
  },
  text: string,
): AssistantCitation | null {
  if (!text.trim() || text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) return null;
  const quote = text.replace(/\s+/g, " ");
  const rendered = renderedMarkdownText(parseMarkdownDocument(source.markdown)).replace(
    /\s+/g,
    " ",
  );
  const match = rendered.indexOf(quote);
  const unique = match !== -1 && rendered.indexOf(quote, match + 1) === -1;
  const selector = unique
    ? createAssistantTextSelector(rendered, match, match + quote.length)
    : createAssistantTextSelector(text, 0, text.length);
  if (!selector) return null;
  return {
    version: 1,
    environmentId: source.environmentId,
    threadId: source.threadId,
    messageId: source.messageId,
    ...selector,
    text,
  };
}
