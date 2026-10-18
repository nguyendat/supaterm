import { describe, expect, it } from "vite-plus/test";
import { MERMAID_LIMITS as limits } from "./limits.ts";
import { renderMermaidSvg, type SvgRenderOptions } from "./svg.ts";

const options: SvgRenderOptions = {
  colors: { bg: "var(--background)", fg: "var(--foreground)" },
  font: "var(--font-sans)",
};

const fixtures = import.meta.glob<string>("./testdata/unicode/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("renderMermaidSvg", () => {
  it.each(Object.entries(fixtures))("renders %s from theme variables only", (_file, content) => {
    const source = content
      .slice(0, content.indexOf("\n---\n"))
      .replace(/^padding[xy]\s*=\s*\d+\s*$/gim, "");
    const svg = renderMermaidSvg(source, options);
    expect(svg).toContain("--diagram-bg:var(--background);--diagram-fg:var(--foreground)");
    expect(svg).not.toMatch(/@import|url\((?!#)|<script|https?:\/\/(?!www\.w3\.org\/2000\/svg")/);
  });

  it.each([
    ["sequenceDiagram\nAlice->>Bob: hi", "<line"],
    ["classDiagram\nclass Animal {\n+name: string\n}\nAnimal <|-- Dog", "Animal"],
    ["erDiagram\nPROJECT ||--o{ THREAD : has", "THREAD"],
    ["xychart-beta\nx-axis [a, b]\nbar [1, 2]", "xychart-bar"],
    ["stateDiagram-v2\n[*] --> Idle\nIdle --> Running", "Running"],
  ])("renders every supported diagram type", (source, marker) => {
    expect(renderMermaidSvg(source, options)).toContain(marker);
  });

  it("keeps color styles and drops properties or values that could reach outside the diagram", () => {
    const svg = renderMermaidSvg(
      [
        "graph TD",
        "A --> B",
        "classDef hot fill:#f96,stroke:url(https://example.com/x),onload:alert(1)",
        "class A hot",
        "style B fill:URL(#x),color:#123456",
      ].join("\n"),
      options,
    );
    expect(svg).toContain('fill="#f96"');
    expect(svg).toContain("#123456");
    expect(svg).not.toMatch(/example\.com|URL\(#x\)|onload/);
  });

  it.each([
    'graph TD\nA["<img src=x onerror=alert(1)>"] -->|"<script>x</script>"| B',
    "sequenceDiagram\nAlice->>Bob: <img src=x onerror=alert(1)>\nNote over Bob: <script>x</script>",
    "classDiagram\nclass A {\n+<img src=x onerror=alert(1)> name\n}",
    'erDiagram\nA ||--o{ B : "<script>x</script>"',
    'xychart-beta\ntitle "<img src=x onerror=alert(1)>"\nx-axis ["<script>"]\nbar [1]',
  ])("renders markup in labels as text", (source) => {
    const markup = renderMermaidSvg(source, options).replace(/"[^"]*"/g, '""');
    expect(markup).not.toMatch(/<(script|img)\b|<[^>]*\sonerror=/);
  });

  it("applies the shared size limits before layout", () => {
    const classes = Array.from({ length: limits.nodes + 1 }, (_, index) => `class C${index}`);
    expect(() => renderMermaidSvg(`classDiagram\n${classes.join("\n")}`, options)).toThrow(
      /classes/,
    );
    const messages = Array.from({ length: limits.edges + 1 }, () => "A->>B: hi");
    expect(() => renderMermaidSvg(`sequenceDiagram\n${messages.join("\n")}`, options)).toThrow(
      /messages/,
    );
  });

  it("bounds chart ticks when the axis range is below floating-point precision", () => {
    const svg = renderMermaidSvg(
      "xychart-beta\nx-axis [a, b]\nbar [1152921504606846976, 1152921504606847232]",
      options,
    );
    expect(svg.match(/class="xychart-label"/g)!.length).toBeLessThan(40);
  });

  it("returns nothing for diagrams without content", () => {
    expect(renderMermaidSvg("sequenceDiagram", options)).toBe("");
    expect(renderMermaidSvg("classDiagram", options)).toBe("");
  });
});
