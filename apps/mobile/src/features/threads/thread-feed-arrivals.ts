// Late measurement corrections for the same arrival keep gliding; later scrolls do not.
const ARRIVAL_SETTLE_MS = 150;

export type ThreadFeedArrivalRow = {
  readonly key: string;
  /** Survives the key changes a row goes through as it settles, such as a live tool row. */
  readonly identity: string;
};

/**
 * Keys of rows that joined below the rows the reader already had. Rows inserted above them
 * (history, disclosures, folds) are not arrivals, nor is a row whose key changes while it
 * stays the same row. A status row that stays last does not hide rows inserted above it.
 */
export function findArrivedFeedKeys(
  previous: ReadonlyArray<ThreadFeedArrivalRow>,
  next: ReadonlyArray<ThreadFeedArrivalRow>,
): ReadonlyArray<string> {
  if (previous.length === 0) return next.map((row) => row.key);
  const known = new Set(previous.map((row) => row.identity));
  const tail = previous.at(-1)?.identity;
  const persistentTail = next.at(-1)?.identity === tail ? tail : undefined;
  const anchor = next.findLastIndex(
    (row) => row.identity !== persistentTail && known.has(row.identity),
  );
  if (anchor < 0) return [];
  return next.slice(anchor + 1).flatMap((row) => (known.has(row.identity) ? [] : [row.key]));
}

export type ArrivalGlideGate = { readonly armedUntil: number; readonly settling: boolean };

export const CLOSED_ARRIVAL_GLIDE_GATE: ArrivalGlideGate = { armedUntil: 0, settling: false };

/**
 * The gate after a scroll jump joins the arrival glide, or null when the jump must stay
 * instant. The first jump has to move content up, which a reader dragging toward history
 * never does; once it is in, later jumps of either sign settle the same arrival.
 */
export function admitArrivalJump(
  gate: ArrivalGlideGate,
  jump: number,
  now: number,
): ArrivalGlideGate | null {
  "worklet";
  if (jump === 0 || now >= gate.armedUntil) return null;
  if (gate.settling) return gate;
  if (jump < 0) return null;
  return { armedUntil: Math.min(gate.armedUntil, now + ARRIVAL_SETTLE_MS), settling: true };
}
