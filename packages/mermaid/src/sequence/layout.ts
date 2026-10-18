import type {
  SequenceDiagram,
  PositionedSequenceDiagram,
  PositionedActor,
  Lifeline,
  PositionedMessage,
  Activation,
  PositionedBlock,
  PositionedNote,
} from "./types.ts";
import type { RenderOptions } from "../types.ts";
import { estimateTextWidth, FONT_SIZES, FONT_WEIGHTS } from "../styles.ts";
const SEQ = {
  padding: 30,
  actorGap: 140,
  actorHeight: 40,
  actorPadX: 16,
  headerGap: 20,
  messageRowHeight: 40,
  selfMessageHeight: 30,
  activationWidth: 10,
  blockPadX: 10,
  blockPadTop: 40,
  blockPadBottom: 8,
  blockHeaderExtra: 28,
  dividerExtra: 24,
  noteWidth: 60,
  notePadX: 12,
  notePadY: 6,
  noteGap: 10,
} as const;
export function layoutSequenceDiagram(
  diagram: SequenceDiagram,
  _options: RenderOptions = {},
): PositionedSequenceDiagram {
  if (diagram.actors.length === 0) {
    return {
      width: 0,
      height: 0,
      actors: [],
      lifelines: [],
      messages: [],
      activations: [],
      blocks: [],
      notes: [],
    };
  }
  const actorWidths = diagram.actors.map((a) => {
    const textW = estimateTextWidth(a.label, FONT_SIZES.nodeLabel, FONT_WEIGHTS.nodeLabel);
    return Math.max(textW + SEQ.actorPadX * 2, 80);
  });
  const actorCenterX: number[] = [];
  let currentX = SEQ.padding + actorWidths[0]! / 2;
  for (let i = 0; i < diagram.actors.length; i++) {
    if (i > 0) {
      const minGap = Math.max(SEQ.actorGap, (actorWidths[i - 1]! + actorWidths[i]!) / 2 + 40);
      currentX += minGap;
    }
    actorCenterX.push(currentX);
  }
  const actorIndex = new Map<string, number>();
  for (let i = 0; i < diagram.actors.length; i++) {
    actorIndex.set(diagram.actors[i]!.id, i);
  }
  const actorY = SEQ.padding;
  const actors: PositionedActor[] = diagram.actors.map((a, i) => ({
    id: a.id,
    label: a.label,
    type: a.type,
    x: actorCenterX[i]!,
    y: actorY,
    width: actorWidths[i]!,
    height: SEQ.actorHeight,
  }));
  let messageY = actorY + SEQ.actorHeight + SEQ.headerGap;
  const messages: PositionedMessage[] = [];
  const extraSpaceBefore = new Map<number, number>();
  for (const block of diagram.blocks) {
    const prev = extraSpaceBefore.get(block.startIndex) ?? 0;
    extraSpaceBefore.set(block.startIndex, Math.max(prev, SEQ.blockHeaderExtra));
    for (const div of block.dividers) {
      const prevDiv = extraSpaceBefore.get(div.index) ?? 0;
      extraSpaceBefore.set(div.index, Math.max(prevDiv, SEQ.dividerExtra));
    }
  }
  const notesByAfterIndex = new Map<number, typeof diagram.notes>();
  for (const note of diagram.notes) {
    const list = notesByAfterIndex.get(note.afterIndex) ?? [];
    list.push(note);
    notesByAfterIndex.set(note.afterIndex, list);
  }
  const positionedNotes: PositionedNote[] = [];
  const activationStacks = new Map<
    string,
    {
      startY: number;
      depth: number;
    }[]
  >();
  const activations: Activation[] = [];
  const nestingOffset = 4;
  for (let msgIdx = 0; msgIdx < diagram.messages.length; msgIdx++) {
    const msg = diagram.messages[msgIdx]!;
    const fromIdx = actorIndex.get(msg.from) ?? 0;
    const toIdx = actorIndex.get(msg.to) ?? 0;
    const isSelf = msg.from === msg.to;
    const extra = extraSpaceBefore.get(msgIdx) ?? 0;
    if (extra > 0) messageY += extra;
    const x1 = actorCenterX[fromIdx]!;
    const x2 = actorCenterX[toIdx]!;
    messages.push({
      from: msg.from,
      to: msg.to,
      label: msg.label,
      lineStyle: msg.lineStyle,
      arrowHead: msg.arrowHead,
      x1,
      x2,
      y: messageY,
      isSelf,
    });
    if (msg.activate) {
      if (!activationStacks.has(msg.to)) {
        activationStacks.set(msg.to, []);
      }
      const stack = activationStacks.get(msg.to)!;
      const depth = stack.length;
      stack.push({ startY: messageY, depth });
    }
    if (msg.deactivate) {
      const stack = activationStacks.get(msg.from);
      if (stack && stack.length > 0) {
        const { startY, depth } = stack.pop()!;
        const idx = actorIndex.get(msg.from) ?? 0;
        const xOffset = depth * nestingOffset;
        activations.push({
          actorId: msg.from,
          x: actorCenterX[idx]! - SEQ.activationWidth / 2 + xOffset,
          topY: startY,
          bottomY: messageY,
          width: SEQ.activationWidth,
        });
      }
    }
    messageY += isSelf ? SEQ.selfMessageHeight + SEQ.messageRowHeight : SEQ.messageRowHeight;
    const notesForMsg = notesByAfterIndex.get(msgIdx);
    if (notesForMsg && notesForMsg.length > 0) {
      const selfLoopExtra = isSelf ? SEQ.selfMessageHeight : 0;
      let noteY = messages[msgIdx]!.y + selfLoopExtra + 8;
      for (const note of notesForMsg) {
        const noteW = Math.max(
          SEQ.noteWidth,
          estimateTextWidth(note.text, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel) +
            SEQ.notePadX * 2,
        );
        const noteH = FONT_SIZES.edgeLabel + SEQ.notePadY * 2;
        const firstActorIdx = actorIndex.get(note.actorIds[0] ?? "") ?? 0;
        let noteX: number;
        if (note.position === "left") {
          noteX =
            actorCenterX[firstActorIdx]! - actorWidths[firstActorIdx]! / 2 - noteW - SEQ.noteGap;
        } else if (note.position === "right") {
          noteX = actorCenterX[firstActorIdx]! + actorWidths[firstActorIdx]! / 2 + SEQ.noteGap;
        } else {
          if (note.actorIds.length > 1) {
            const lastActorIdx =
              actorIndex.get(note.actorIds[note.actorIds.length - 1] ?? "") ?? firstActorIdx;
            noteX = (actorCenterX[firstActorIdx]! + actorCenterX[lastActorIdx]!) / 2 - noteW / 2;
          } else {
            noteX = actorCenterX[firstActorIdx]! - noteW / 2;
          }
        }
        positionedNotes.push({
          text: note.text,
          x: noteX,
          y: noteY,
          width: noteW,
          height: noteH,
          position: note.position,
          actors: note.actorIds,
        });
        noteY += noteH + 4;
      }
      messageY = Math.max(messageY, noteY + SEQ.messageRowHeight / 2);
    }
  }
  for (const [actorId, stack] of activationStacks) {
    for (const { startY, depth } of stack) {
      const idx = actorIndex.get(actorId) ?? 0;
      const xOffset = depth * nestingOffset;
      activations.push({
        actorId,
        x: actorCenterX[idx]! - SEQ.activationWidth / 2 + xOffset,
        topY: startY,
        bottomY: messageY - SEQ.messageRowHeight / 2,
        width: SEQ.activationWidth,
      });
    }
  }
  const blocks: PositionedBlock[] = diagram.blocks.map((block) => {
    const startMsg = messages[block.startIndex];
    const endMsg = messages[block.endIndex];
    const blockTop = (startMsg?.y ?? messageY) - SEQ.blockPadTop;
    const blockBottom = (endMsg?.y ?? messageY) + SEQ.blockPadBottom + 12;
    const involvedActors = new Set<number>();
    for (let mi = block.startIndex; mi <= block.endIndex; mi++) {
      const m = diagram.messages[mi];
      if (m) {
        involvedActors.add(actorIndex.get(m.from) ?? 0);
        involvedActors.add(actorIndex.get(m.to) ?? 0);
      }
    }
    if (involvedActors.size === 0) {
      for (let ai = 0; ai < diagram.actors.length; ai++) involvedActors.add(ai);
    }
    const minIdx = Math.min(...involvedActors);
    const maxIdx = Math.max(...involvedActors);
    const blockLeft = actorCenterX[minIdx]! - actorWidths[minIdx]! / 2 - SEQ.blockPadX;
    const blockRight = actorCenterX[maxIdx]! + actorWidths[maxIdx]! / 2 + SEQ.blockPadX;
    const dividers = block.dividers.map((d) => {
      const msg = messages[d.index];
      const msgY = msg?.y ?? messageY;
      let offset = 28;
      if (d.label && msg?.label) {
        const divLabelText = `[${d.label}]`;
        const divLabelW = estimateTextWidth(
          divLabelText,
          FONT_SIZES.edgeLabel,
          FONT_WEIGHTS.edgeLabel,
        );
        const divLabelLeft = blockLeft + 8;
        const divLabelRight = divLabelLeft + divLabelW;
        const msgLabelW = estimateTextWidth(
          msg.label,
          FONT_SIZES.edgeLabel,
          FONT_WEIGHTS.edgeLabel,
        );
        const msgLabelLeft = msg.isSelf ? msg.x1 + 36 : (msg.x1 + msg.x2) / 2 - msgLabelW / 2;
        const msgLabelRight = msgLabelLeft + msgLabelW;
        if (divLabelRight > msgLabelLeft && divLabelLeft < msgLabelRight) {
          offset = 36;
        }
      }
      return { y: msgY - offset, label: d.label };
    });
    return {
      type: block.type,
      label: block.label,
      x: blockLeft,
      y: blockTop,
      width: blockRight - blockLeft,
      height: blockBottom - blockTop,
      dividers,
    };
  });
  const notes = positionedNotes;
  const diagramBottom = messageY + SEQ.padding;
  let globalMinX: number = SEQ.padding;
  let globalMaxX = 0;
  for (const a of actors) {
    globalMinX = Math.min(globalMinX, a.x - a.width / 2);
    globalMaxX = Math.max(globalMaxX, a.x + a.width / 2);
  }
  for (const b of blocks) {
    globalMinX = Math.min(globalMinX, b.x);
    globalMaxX = Math.max(globalMaxX, b.x + b.width);
  }
  for (const n of notes) {
    globalMinX = Math.min(globalMinX, n.x);
    globalMaxX = Math.max(globalMaxX, n.x + n.width);
  }
  for (const m of messages) {
    if (m.isSelf && m.label) {
      const loopW = 30;
      const labelPadding = 8;
      const labelLeft = m.x1 + loopW + labelPadding;
      const labelWidth = estimateTextWidth(m.label, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel);
      globalMaxX = Math.max(globalMaxX, labelLeft + labelWidth + 8);
    }
  }
  const shiftX = globalMinX < SEQ.padding ? SEQ.padding - globalMinX : 0;
  if (shiftX > 0) {
    for (const a of actors) a.x += shiftX;
    for (const m of messages) {
      m.x1 += shiftX;
      m.x2 += shiftX;
    }
    for (const act of activations) act.x += shiftX;
    for (const b of blocks) {
      b.x += shiftX;
    }
    for (const n of notes) n.x += shiftX;
    for (let i = 0; i < actorCenterX.length; i++) actorCenterX[i]! += shiftX;
  }
  const lifelines: Lifeline[] = diagram.actors.map((a, i) => ({
    actorId: a.id,
    x: actorCenterX[i]!,
    topY: actorY + SEQ.actorHeight,
    bottomY: diagramBottom - SEQ.padding,
  }));
  const diagramWidth = globalMaxX + shiftX + SEQ.padding;
  const diagramHeight = diagramBottom;
  return {
    width: Math.max(diagramWidth, 200),
    height: Math.max(diagramHeight, 100),
    actors,
    lifelines,
    messages,
    activations,
    blocks,
    notes,
  };
}
