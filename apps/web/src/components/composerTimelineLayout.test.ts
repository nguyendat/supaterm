import { describe, expect, it } from "vite-plus/test";

import { resolveComposerTimelineLayout } from "./composerFooterLayout";

describe("composer timeline layout", () => {
  it("reveals the reclaimed reading space while preserving the expanded scroll reservation", () => {
    const expanded = resolveComposerTimelineLayout({
      currentInset: 0,
      overlayHeight: 320,
      isResting: false,
    });
    const resting = resolveComposerTimelineLayout({
      currentInset: expanded.contentInsetEndAdjustment,
      overlayHeight: 64,
      isResting: true,
    });

    expect(expanded).toEqual({ contentInsetEndAdjustment: 320, composerOverlayHeight: 320 });
    expect(resting).toEqual({ contentInsetEndAdjustment: 320, composerOverlayHeight: 64 });

    const restored = resolveComposerTimelineLayout({
      currentInset: resting.contentInsetEndAdjustment,
      overlayHeight: 320,
      isResting: false,
    });
    expect(restored).toEqual(expanded);
  });
});
