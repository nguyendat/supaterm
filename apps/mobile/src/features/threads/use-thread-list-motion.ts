import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import {
  Easing,
  ReduceMotion,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  type LayoutAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";

import { useReducedMotionPreference } from "../../lib/useReducedMotionPreference";
import {
  shouldAnimateThreadList,
  THREAD_LIST_ALIGNED_ENTRY_DELAY,
  THREAD_LIST_MOTION_DURATION,
  type ThreadListMotionItem,
} from "./thread-list-motion";
import { isKeyboardMotionSuppressed } from "../../lib/motionInput";
import { MOTION_ENTER_DURATION_MS, MOTION_EXIT_DURATION_MS } from "../../lib/motionTiming";

/** Uses LegendList's recycling guards while animating only visible cells' transforms and opacity. */
export function useThreadListMotion(input: {
  readonly items: ReadonlyArray<ThreadListMotionItem>;
  readonly scope: string;
  readonly searching: boolean;
  readonly scrolling: boolean;
  readonly ready: boolean;
  readonly settledLimit?: number;
  /** Raises every row together, such as above a keyboard. */
  readonly lift?: SharedValue<number>;
}) {
  const { items, scope, searching, scrolling, ready, settledLimit = 0, lift } = input;
  const reducedMotion = useReducedMotionPreference();
  const frame = useMemo(
    () => ({ items: items.map(({ key, expanded }) => ({ key, expanded })), scope, settledLimit }),
    [items, scope, settledLimit],
  );
  const previous = useRef<typeof frame | null>(null);
  const deadline = useSharedValue(0);
  const alignmentPadding = useSharedValue(0);
  const alignmentOffset = useSharedValue(0);
  const anchoredUntil = useSharedValue(0);
  const skipUntil = useRef(0);
  /** Call before a local change. An anchored change is one the list keeps in
      place by scrolling once its rows overflow, so it switches in place there. */
  const prepare = useCallback(
    (options?: { readonly anchored?: boolean }) => {
      if (!ready || reducedMotion || scrolling || searching || isKeyboardMotionSuppressed()) return;
      const anchored = options?.anchored === true;
      if (anchored && alignmentPadding.get() === 0) {
        skipUntil.current = performance.now() + 300;
        runOnUI(() => {
          "worklet";
          deadline.set(0);
        })();
        return;
      }
      runOnUI((anchoredChange: boolean) => {
        "worklet";
        const until = performance.now() + 300;
        deadline.set(until);
        anchoredUntil.set(anchoredChange ? until : 0);
      })(anchored);
    },
    [alignmentPadding, anchoredUntil, deadline, ready, reducedMotion, scrolling, searching],
  );
  const timing = useMemo(
    () => ({
      duration: THREAD_LIST_MOTION_DURATION,
      easing: Easing.bezier(0.645, 0.045, 0.355, 1),
      reduceMotion: ReduceMotion.Never,
    }),
    [],
  );
  useLayoutEffect(() => {
    const animate =
      ready &&
      performance.now() >= skipUntil.current &&
      previous.current !== null &&
      !isKeyboardMotionSuppressed() &&
      shouldAnimateThreadList({
        items: frame.items,
        scope: frame.scope,
        previousItems: previous.current.items,
        previousScope: previous.current.scope,
        searching,
        previousSettledLimit: previous.current.settledLimit,
        settledLimit: frame.settledLimit,
      });
    previous.current = ready ? frame : null;
    // Bound eligibility without scheduling an animation just to expire a flag.
    runOnUI((allow: boolean) => {
      "worklet";
      deadline.set(allow ? performance.now() + 300 : 0);
    })(animate && !reducedMotion && !scrolling);
  }, [deadline, frame, scrolling, searching, reducedMotion, ready]);

  useAnimatedReaction(
    () => ({ padding: alignmentPadding.value, deadline: deadline.value }),
    (next, previous) => {
      // An anchored change that overflows is kept in place by the list's scroll
      // position instead of this offset.
      if (next.deadline === 0 || (next.padding === 0 && performance.now() < anchoredUntil.value)) {
        alignmentOffset.set(0);
      } else if (previous && next.padding !== previous.padding) {
        if (performance.now() < next.deadline) {
          // The recycler commits its spacer immediately. Keep the visual position
          // continuous, including when a second toggle interrupts the movement.
          alignmentOffset.set(alignmentOffset.value + previous.padding - next.padding);
          alignmentOffset.set(withTiming(0, timing));
        } else {
          alignmentOffset.set(0);
        }
      }
    },
    [timing],
  );
  const alignmentStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: alignmentOffset.value - (lift?.value ?? 0) }],
  }));
  const sharedValues = useMemo(
    () => ({ alignItemsAtEndPadding: alignmentPadding }),
    [alignmentPadding],
  );

  return useMemo(() => {
    const entryTiming = {
      ...timing,
      duration: MOTION_ENTER_DURATION_MS,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
    };
    const layout: LayoutAnimationFunction = (values) => {
      "worklet";
      const visible =
        values.currentGlobalOriginY + values.currentHeight > 0 &&
        values.currentGlobalOriginY < values.windowHeight &&
        values.targetGlobalOriginY + values.targetHeight > 0 &&
        values.targetGlobalOriginY < values.windowHeight;
      const offset =
        performance.now() < deadline.value && visible
          ? values.currentOriginY - values.targetOriginY
          : 0;
      const geometry = {
        originX: values.targetOriginX,
        originY: values.targetOriginY,
        width: values.targetWidth,
        height: values.targetHeight,
      };
      return {
        initialValues: { ...geometry, transform: [{ translateY: offset }] },
        animations: {
          ...geometry,
          transform: [{ translateY: offset === 0 ? 0 : withTiming(0, timing) }],
        },
      };
    };
    const entering = (values: EntryAnimationsValues) => {
      "worklet";
      const animateEntry =
        performance.now() < deadline.value &&
        values.targetGlobalOriginY + values.targetHeight > 0 &&
        values.targetGlobalOriginY < values.windowHeight;
      // Rows inserted into a bottom-aligned list slide in over their neighbours,
      // so they fade in once that slide has nearly settled.
      const delay = alignmentPadding.value > 0 ? THREAD_LIST_ALIGNED_ENTRY_DELAY : 0;
      return {
        initialValues: {
          opacity: animateEntry ? 0 : 1,
          transform: [{ translateY: animateEntry ? -4 : 0 }],
        },
        animations: {
          opacity: animateEntry ? withDelay(delay, withTiming(1, entryTiming)) : 1,
          transform: [
            { translateY: animateEntry ? withDelay(delay, withTiming(0, entryTiming)) : 0 },
          ],
        },
      };
    };
    const exiting = (values: ExitAnimationsValues) => {
      "worklet";
      const animateExit =
        performance.now() < deadline.value &&
        values.currentGlobalOriginY + values.currentHeight > 0 &&
        values.currentGlobalOriginY < values.windowHeight;
      return {
        initialValues: { opacity: 1 },
        animations: {
          opacity: animateExit
            ? withTiming(0, { ...entryTiming, duration: MOTION_EXIT_DURATION_MS })
            : 0,
        },
      };
    };
    return { layout, entering, exiting, alignmentStyle, prepare, sharedValues };
  }, [alignmentPadding, alignmentStyle, deadline, prepare, sharedValues, timing]);
}
