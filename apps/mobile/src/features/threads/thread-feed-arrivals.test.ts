import { describe, expect, it } from "vite-plus/test";

import {
  admitArrivalJump,
  CLOSED_ARRIVAL_GLIDE_GATE,
  findArrivedFeedKeys,
  type ThreadFeedArrivalRow,
} from "./thread-feed-arrivals";

const rows = (...keys: string[]): ThreadFeedArrivalRow[] =>
  keys.map((key) => ({ key, identity: key }));

describe("thread feed arrivals", () => {
  it("reports rows appended after the known feed", () => {
    expect(
      findArrivedFeedKeys(rows("user", "reply"), rows("user", "reply", "next", "thinking")),
    ).toEqual(["next", "thinking"]);
  });

  it("reports rows inserted above a status row that stays last", () => {
    expect(
      findArrivedFeedKeys(rows("user", "thinking"), rows("user", "reply", "thinking")),
    ).toEqual(["reply"]);
  });

  it("reports everything once a visible empty feed gains rows", () => {
    expect(findArrivedFeedKeys([], rows("pending"))).toEqual(["pending"]);
  });

  it("ignores history loaded above the known feed, even alongside an append", () => {
    expect(findArrivedFeedKeys(rows("user", "reply"), rows("older", "user", "reply"))).toEqual([]);
    expect(
      findArrivedFeedKeys(rows("user", "reply"), rows("older", "user", "reply", "next")),
    ).toEqual(["next"]);
  });

  it("ignores a fold that replaces rows above the latest message", () => {
    expect(
      findArrivedFeedKeys(
        rows("user", "tool-a", "tool-b", "reply", "thinking"),
        rows("user", "fold", "reply"),
      ),
    ).toEqual([]);
  });

  it("ignores a row whose key changes while it stays the same row", () => {
    const live = [
      { key: "user", identity: "user" },
      { key: "live-activity-row", identity: "group-1" },
    ];
    const settled = [
      { key: "user", identity: "user" },
      { key: "work-toggle:group-1", identity: "group-1" },
      { key: "live-activity-row", identity: "live-activity-row" },
    ];
    expect(findArrivedFeedKeys(live, settled)).toEqual(["live-activity-row"]);
  });

  it("ignores a feed that shares no rows with the previous one", () => {
    expect(findArrivedFeedKeys(rows("a", "b"), rows("c", "d"))).toEqual([]);
  });
});

describe("arrival glide gate", () => {
  const armed = { armedUntil: 1_000, settling: false };

  it("starts on an upward jump and narrows the window to its corrections", () => {
    expect(admitArrivalJump(armed, 92, 100)).toEqual({ armedUntil: 250, settling: true });
    expect(admitArrivalJump({ armedUntil: 250, settling: true }, -92, 110)).toEqual({
      armedUntil: 250,
      settling: true,
    });
  });

  it("never starts on a downward jump", () => {
    expect(admitArrivalJump(armed, -40, 100)).toBeNull();
  });

  it("stays instant once the window closes", () => {
    expect(admitArrivalJump(armed, 92, 1_000)).toBeNull();
    expect(admitArrivalJump(CLOSED_ARRIVAL_GLIDE_GATE, 92, 0)).toBeNull();
  });
});
