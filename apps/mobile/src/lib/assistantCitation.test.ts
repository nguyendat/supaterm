import { describe, expect, it } from "vite-plus/test";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@supacode/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
  withAssistantCitationComment,
  expandAssistantCitationsForProvider,
} from "@supacode/shared/assistantCitations";
import { captureAssistantCitation } from "./assistantCitation";

const source = {
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("source-thread"),
  messageId: MessageId.make("assistant-message"),
};

describe("mobile assistant citations", () => {
  it("quotes rendered formatting and links with their source identity", () => {
    const citation = captureAssistantCitation(
      { ...source, markdown: "Before **use the [guide](https://example.com)** after." },
      "use the guide",
    );
    expect(citation).toMatchObject({
      ...source,
      text: "use the guide",
      start: 7,
      end: 20,
      prefix: "Before ",
      suffix: " after.",
    });
    const bound = withAssistantCitationComment(citation!, "Explain the steps\nwith examples");
    const prompt = `Revisit ${serializeAssistantCitation(bound)}`;
    expect(collectAssistantCitations(prompt)[0]?.citation).toEqual(bound);
    expect(expandAssistantCitationsForProvider(prompt)).toContain(
      '"comment": "Explain the steps\\nwith examples"',
    );
  });

  it("preserves selected code indentation and Unicode while normalizing source offsets", () => {
    const text = "const emoji = '😀';\n  run(emoji);";
    const citation = captureAssistantCitation(
      { ...source, markdown: `Use this:\n\n\`\`\`ts\n${text}\n\`\`\`` },
      text,
    );
    expect(citation).toMatchObject({
      text,
      start: 10,
      end: 10 + text.replace(/\s+/g, " ").length,
      prefix: "Use this: ",
      suffix: "",
    });
  });

  it("keeps repeated or native-only text readable without claiming a unique source location", () => {
    for (const markdown of ["repeat and repeat", "A [file](src/file.ts)"]) {
      const text = markdown.startsWith("repeat") ? "repeat" : "file.ts";
      expect(captureAssistantCitation({ ...source, markdown }, text)).toMatchObject({
        text,
        prefix: "",
        suffix: "",
      });
    }
  });

  it("does not split emoji at source context boundaries", () => {
    const markdown = `😀${"a".repeat(31)}quote${"b".repeat(31)}😀`;
    const citation = captureAssistantCitation({ ...source, markdown }, "quote")!;
    expect(citation.prefix).toBe("a".repeat(31));
    expect(citation.suffix).toBe("b".repeat(31));
    expect(collectAssistantCitations(serializeAssistantCitation(citation))[0]?.citation).toEqual(
      citation,
    );
  });

  it("rejects empty and over-limit selections without truncating them", () => {
    for (const text of [" \n\t", "x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1)])
      expect(captureAssistantCitation({ ...source, markdown: text }, text)).toBeNull();
    const text = "x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH);
    expect(captureAssistantCitation({ ...source, markdown: text }, text)?.text).toBe(text);
  });
});
