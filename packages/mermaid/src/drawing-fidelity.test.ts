import { describe, expect, it } from "vite-plus/test";
import { renderMermaidAscii } from "./ascii/index.ts";

describe.each([false, true])("drawing fidelity with useAscii=%s", (useAscii) => {
  it("preserves bottom-to-top node and edge labels while pointing arrows upward", () => {
    const output = renderMermaidAscii(
      'graph BT\nA["Save ^v ▲▼<br/>Value ┌└"] -->|Move ^v ▲▼<br/>Review ┬┴| B["Done"]',
      { useAscii },
    );

    for (const label of ["Save ^v ▲▼", "Value ┌└", "Move ^v ▲▼", "Review ┬┴", "Done"]) {
      expect(output).toContain(label);
    }
    expect(output.indexOf("Done")).toBeLessThan(output.indexOf("Save ^v ▲▼"));
    expect(output.indexOf("Save ^v ▲▼")).toBeLessThan(output.indexOf("Value ┌└"));
    expect(output.indexOf("Move ^v ▲▼")).toBeLessThan(output.indexOf("Review ┬┴"));
    expect(output).toMatch(useAscii ? /^\s*\^\s*$/m : /^\s*▲\s*$/m);
  });

  it("preserves bottom-to-top subgraph labels", () => {
    const output = renderMermaidAscii(
      'graph BT\nsubgraph S["Overview ^v ▲▼<br/>Review ┌└"]\nA --> B\nend',
      { useAscii },
    );

    expect(output).toContain("Overview ^v ▲▼");
    expect(output).toContain("Review ┌└");
    expect(output.indexOf("Overview ^v ▲▼")).toBeLessThan(output.indexOf("Review ┌└"));
  });

  it.each(["TD", "LR", "BT"])("sizes nested %s subgraphs for their full title", (direction) => {
    const output = renderMermaidAscii(
      `graph ${direction}\nsubgraph S["Outer long title<br/>Second line<br/>Third line<br/>Fourth line"]\nsubgraph T["Inner long title"]\nA --> B\nend\nend`,
      { useAscii },
    );

    for (const label of [
      "Outer long title",
      "Second line",
      "Third line",
      "Fourth line",
      "Inner long title",
    ]) {
      expect(output).toContain(label);
    }
    expect(output.indexOf("Outer long title")).toBeLessThan(output.indexOf("Second line"));
    expect(output.indexOf("Second line")).toBeLessThan(output.indexOf("Third line"));
    expect(output.indexOf("Third line")).toBeLessThan(output.indexOf("Fourth line"));
  });

  it("rejects titles that cannot fit after sibling subgraphs are separated", () => {
    expect(() =>
      renderMermaidAscii(
        'graph LR\nsubgraph S["Long left title"]\nA\nend\nsubgraph T["Long right title"]\nB\nend\nA --> B',
        { useAscii },
      ),
    ).toThrow("Subgraph label does not fit inside its bounds");
  });

  it("renders initial sequence notes before the first message and keeps later notes in order", () => {
    const output = renderMermaidAscii(
      "sequenceDiagram\nNote over A: Before\nNote right of A: Next\nA->>B: Send\nNote right of B: After",
      { useAscii },
    );

    for (const label of ["Before", "Next", "Send", "After"]) expect(output).toContain(label);
    expect(output.indexOf("Before")).toBeLessThan(output.indexOf("Next"));
    expect(output.indexOf("Next")).toBeLessThan(output.indexOf("Send"));
    expect(output.indexOf("Send")).toBeLessThan(output.indexOf("After"));
  });

  it("renders a sequence diagram containing only notes", () => {
    const output = renderMermaidAscii("sequenceDiagram\nNote over A: Only<br/>note", {
      useAscii,
    });

    expect(output).toContain("Only");
    expect(output).toContain("note");
    expect(output.indexOf("Only")).toBeLessThan(output.indexOf("note"));
  });
});
