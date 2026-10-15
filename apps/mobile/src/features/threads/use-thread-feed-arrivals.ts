import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react-native";
import {
  cancelAnimation,
  clamp,
  Easing,
  ReduceMotion,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type LayoutAnimationFunction,
} from "react-native-reanimated";
import { useGenericKeyboardHandler } from "react-native-keyboard-controller";

import {
  admitArrivalJump,
  CLOSED_ARRIVAL_GLIDE_GATE,
  findArrivedFeedKeys,
  type ArrivalGlideGate,
  type ThreadFeedArrivalRow,
} from "./thread-feed-arrivals";

// Covers the arrived row's mount, measurement, and LegendList's end-follow frame.
const ARRIVAL_ARM_MS = 600;
// Arrived rows fade in only on their first mount. LegendList remounts rows that
// scroll back into view, and replaying an entrance for old content is its own jank.
const ARRIVAL_FADE_WINDOW_MS = 1_000;
const ARRIVAL_GLIDE_TIMING = {
  duration: 240,
  easing: Easing.bezier(0.32, 0.72, 0, 1),
  reduceMotion: ReduceMotion.Never,
};

/**
 * Tracks rows arriving in a thread feed so they fade in on first mount, and glides the item
 * layer over the instant jump they cause: an end-follow scroll in a long feed, or shrinking
 * alignItemsAtEnd padding in a short one. Scroll and alignment math stay exact; only the
 * rendered item layer trails behind. `maxShift` must stay within the rows LegendList keeps
 * rendered above the viewport.
 */
export function useThreadFeedArrivals(maxShift: number) {
  const baselineRef = useRef<{
    readonly threadKey: string;
    readonly listMountKey: string;
    readonly rows: ReadonlyArray<ThreadFeedArrivalRow>;
  } | null>(null);
  const listMountKeyRef = useRef<string | null>(null);
  const arrivedAtRef = useRef(new Map<string, number>());
  const scrollOffset = useSharedValue(0);
  const shift = useSharedValue(0);
  const gate = useSharedValue<ArrivalGlideGate>(CLOSED_ARRIVAL_GLIDE_GATE);
  const keyboardMoving = useSharedValue(false);

  // The chat scroll view moves its offset with the keyboard, writing and reverting
  // targets on Android; none of that is an arrival jump.
  useGenericKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        if (event.duration > 0) keyboardMoving.set(true);
      },
      onInteractive: () => {
        "worklet";
        keyboardMoving.set(true);
      },
      onEnd: () => {
        "worklet";
        keyboardMoving.set(false);
      },
    },
    [keyboardMoving],
  );

  useAnimatedReaction(
    () => scrollOffset.get(),
    (offset, previous) => {
      if (previous === null || keyboardMoving.get()) return;
      const jump = offset - previous;
      const next = admitArrivalJump(gate.get(), jump, performance.now());
      if (next === null) return;
      gate.set(next);
      // Signed, so offsets the list writes and reverts within a frame cancel out.
      shift.set(clamp(shift.get() + jump, -maxShift, maxShift));
      shift.set(withTiming(0, ARRIVAL_GLIDE_TIMING));
    },
  );

  const itemsContainerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: shift.get() }],
  }));
  // The padding reaches the UI thread only through a JS listener, a frame apart from
  // the spacer's commit, so it animates as a layout transition inside that commit.
  // It moves originY because the glide above already owns the layer's transform.
  const itemsContainerLayout = useMemo<LayoutAnimationFunction>(
    () => (values) => {
      "worklet";
      const animate =
        values.currentOriginY > values.targetOriginY &&
        performance.now() < gate.get().armedUntil &&
        !keyboardMoving.get();
      const target = {
        originX: values.targetOriginX,
        width: values.targetWidth,
        height: values.targetHeight,
      };
      return {
        initialValues: {
          ...target,
          originY: animate ? values.currentOriginY : values.targetOriginY,
        },
        animations: {
          ...target,
          originY: animate
            ? withTiming(values.targetOriginY, ARRIVAL_GLIDE_TIMING)
            : values.targetOriginY,
        },
      };
    },
    [gate, keyboardMoving],
  );
  const sharedValues = useMemo(() => ({ scrollOffset }), [scrollOffset]);

  const glide = useCallback(() => {
    runOnUI(() => {
      "worklet";
      gate.set({ armedUntil: performance.now() + ARRIVAL_ARM_MS, settling: false });
    })();
  }, [gate]);
  const disarm = useCallback(() => {
    runOnUI(() => {
      "worklet";
      gate.set(CLOSED_ARRIVAL_GLIDE_GATE);
    })();
  }, [gate]);
  const reset = useCallback(() => {
    runOnUI(() => {
      "worklet";
      gate.set(CLOSED_ARRIVAL_GLIDE_GATE);
      cancelAnimation(shift);
      shift.set(0);
    })();
  }, [gate, shift]);

  /**
   * Records the committed feed so arrived rows fade in, and returns the keys that arrived in
   * the list already on screen, where a glide can follow them. Call it from a layout effect:
   * LegendList mounts arrived rows in the sync pass after it. A feed that is not on screen
   * yet never becomes the baseline arrivals compare against.
   */
  const record = useCallback(
    (input: {
      readonly threadKey: string;
      readonly listMountKey: string;
      readonly rows: ReadonlyArray<ThreadFeedArrivalRow>;
      readonly visible: boolean;
      readonly animate: boolean;
    }): ReadonlyArray<string> => {
      if (listMountKeyRef.current !== input.listMountKey) {
        // A new list reports its own scroll offsets; nothing carries over.
        if (listMountKeyRef.current !== null) reset();
        listMountKeyRef.current = input.listMountKey;
      }
      const previous =
        baselineRef.current?.threadKey === input.threadKey ? baselineRef.current : null;
      baselineRef.current = input.visible
        ? { threadKey: input.threadKey, listMountKey: input.listMountKey, rows: input.rows }
        : previous;
      if (previous === null || !input.visible || !input.animate) return [];
      const arrived = findArrivedFeedKeys(previous.rows, input.rows);
      if (arrived.length === 0) return [];
      const now = Date.now();
      for (const [key, arrivedAt] of arrivedAtRef.current) {
        if (now - arrivedAt >= ARRIVAL_FADE_WINDOW_MS) arrivedAtRef.current.delete(key);
      }
      for (const key of arrived) arrivedAtRef.current.set(key, now);
      return previous.listMountKey === input.listMountKey ? arrived : [];
    },
    [reset],
  );
  const isFresh = useCallback(
    (key: string) => Date.now() - (arrivedAtRef.current.get(key) ?? 0) < ARRIVAL_FADE_WINDOW_MS,
    [],
  );

  return useMemo(
    () => ({
      record,
      isFresh,
      glide,
      disarm,
      itemsContainerLayout,
      itemsContainerStyle,
      sharedValues,
    }),
    [record, isFresh, glide, disarm, itemsContainerLayout, itemsContainerStyle, sharedValues],
  );
}

/** Whether alignItemsAtEnd currently pads a feed shorter than its viewport. */
export function useListBottomAligned(
  listRef: RefObject<LegendListRef | null>,
  listMountKey: string,
) {
  const [bottomAligned, setBottomAligned] = useState(false);
  useEffect(() => {
    const state = listRef.current?.getState();
    if (!state) return;
    setBottomAligned(state.alignItemsAtEndPadding > 0);
    return state.listen("alignItemsAtEndPadding", (padding) => setBottomAligned(padding > 0));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A remount is a new list to listen to.
  }, [listMountKey, listRef]);
  return bottomAligned;
}
