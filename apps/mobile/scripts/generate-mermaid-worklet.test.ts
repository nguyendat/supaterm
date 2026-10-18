import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { renderMermaidAscii } from "../../../packages/mermaid/src/ascii/index.ts";
import { MERMAID_LIMITS as limits } from "../../../packages/mermaid/src/limits.ts";

const supported = [
  "flowchart LR\nA --> B",
  'flowchart LR; A --> B; B["Worker; queue"] --> C',
  "flowchart BT\nA[Save<br/>Verify] --> B[Done]",
  "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hi",
  "sequenceDiagram\nNote over Alice,Bob: Ready\nAlice->>Bob: Hello",
  "stateDiagram-v2\n[*] --> Idle\nIdle --> Running\nRunning --> [*]",
  "classDiagram\nAnimal <|-- Dog\nAnimal : +name string",
  "erDiagram\nUSER ||--o{ ORDER : places",
  'xychart-beta\ntitle "Sales"\nx-axis [Jan, Feb]\ny-axis 0 --> 100\nbar [25, 75]',
];
const rejected = [
  'pie\n"One" : 1',
  'flowchart LR\nA@{ shape: rect, label: "Server" } --> B',
  `graph TD\n${"x".repeat(limits.sourceChars)}`,
  `graph TD\n${"\n".repeat(limits.sourceLines)}`,
  `graph TD\nA[${"x".repeat(limits.lineChars)}]`,
  `graph TD\n${Array.from({ length: limits.nodes + 1 }, (_, index) => `N${index}`).join("\n")}`,
  `graph TD\n${"A --> B\n".repeat(limits.edges + 1)}`,
  `graph TD\n${Array.from({ length: limits.nesting + 1 }, (_, index) => `subgraph G${index}`).join("\n")}\nA --> B\n${"end\n".repeat(limits.nesting + 1)}`,
  `graph TD\nA[${"x".repeat(limits.lineChars - 3)}]`,
];

describe("generated native Mermaid worklet", () => {
  let output: {
    unchanged: boolean;
    platforms: Record<
      string,
      { closureSize: number; outputs: Array<string | null>; rejectsExpiredBudget: boolean }
    >;
  };

  beforeAll(() => {
    output = JSON.parse(
      NodeChildProcess.execFileSync(
        process.execPath,
        [NodeURL.fileURLToPath(new URL("./generate-mermaid-worklet.fixture.mjs", import.meta.url))],
        {
          cwd: NodeURL.fileURLToPath(new URL("..", import.meta.url)),
          input: JSON.stringify([...supported, ...rejected]),
          encoding: "utf8",
          timeout: 30_000,
        },
      ),
    );
  }, 30_000);

  it("preserves rendering and work bounds after native Babel serialization", () => {
    const expected = supported.map((source) => renderMermaidAscii(source, { useAscii: true }));
    for (const source of rejected) expect(() => renderMermaidAscii(source)).toThrow();
    for (const platform of ["ios", "android"]) {
      expect(output.platforms[platform]).toEqual({
        closureSize: 0,
        outputs: [...expected, ...rejected.map(() => null)],
        rejectsExpiredBudget: true,
      });
    }
  });

  it("does not trigger a generated module update when renderer output is unchanged", () => {
    expect(output.unchanged).toBe(true);
  });
});
