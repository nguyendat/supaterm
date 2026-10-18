import { expect, it } from "vite-plus/test";
import { diagramLines } from "../diagram.ts";
import { FONT_SIZES, SEQUENCE_ACTOR_NAME_OFFSET } from "../styles.ts";
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

it("keeps leading notes and the first message below stick-figure actor names", () => {
  const diagram = parseSequenceDiagram(
    diagramLines(
      "sequenceDiagram\nactor Alice\nactor Bob\nNote over Alice,Bob: kickoff\nAlice->>Bob: hello",
    ),
  );
  const { actors, notes, messages } = layoutSequenceDiagram(diagram);
  const nameBottom =
    actors[0]!.y + actors[0]!.height + SEQUENCE_ACTOR_NAME_OFFSET + FONT_SIZES.nodeLabel / 2;
  expect(notes[0]!.y).toBeGreaterThan(nameBottom);
  expect(messages[0]!.y).toBeGreaterThan(notes[0]!.y + notes[0]!.height);
});
