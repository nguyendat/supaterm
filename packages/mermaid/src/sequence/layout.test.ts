import { expect, it } from "vite-plus/test";
import { diagramLines } from "../diagram.ts";
import { layoutSequenceDiagram } from "./layout.ts";
import { parseSequenceDiagram } from "./parser.ts";

it("places notes that come before the first message above it", () => {
  const diagram = parseSequenceDiagram(
    diagramLines("sequenceDiagram\nNote over Alice,Bob: kickoff\nAlice->>Bob: hello"),
  );
  const { notes, messages } = layoutSequenceDiagram(diagram);
  expect(notes.map((note) => note.text)).toEqual(["kickoff"]);
  expect(notes[0]!.y + notes[0]!.height).toBeLessThan(messages[0]!.y);
});
