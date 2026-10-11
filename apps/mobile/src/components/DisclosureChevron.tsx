import { useLayoutEffect, type ComponentProps } from "react";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useReducedMotionPreference } from "../lib/useReducedMotionPreference";
import { isKeyboardMotionSuppressed } from "../lib/motionInput";
import { MOTION_ENTER_DURATION_MS } from "../lib/motionTiming";
import { SymbolView } from "./AppSymbol";

const RIGHT_CHEVRON_EXPANDED_ANGLE = { down: 90, up: -90 } as const;

export function DisclosureChevron(
  props: Pick<ComponentProps<typeof SymbolView>, "size" | "tintColor" | "tintColorClassName"> & {
    readonly expanded: boolean;
    readonly collapsedDirection?: "right" | "down";
    /** Where a right-pointing chevron turns when expanded. */
    readonly expandedDirection?: "down" | "up";
    readonly duration?: number;
  },
) {
  const reducedMotion = useReducedMotionPreference() || isKeyboardMotionSuppressed();
  const direction = props.collapsedDirection ?? "down";
  const expandedAngle =
    direction === "right" ? RIGHT_CHEVRON_EXPANDED_ANGLE[props.expandedDirection ?? "down"] : 180;
  const angle = props.expanded ? expandedAngle : 0;
  const duration = props.duration ?? MOTION_ENTER_DURATION_MS;
  const rotation = useSharedValue(angle);
  useLayoutEffect(() => {
    rotation.set(
      reducedMotion
        ? angle
        : withTiming(angle, {
            duration,
            easing: Easing.bezier(0.645, 0.045, 0.355, 1),
            reduceMotion: ReduceMotion.Never,
          }),
    );
  }, [angle, duration, reducedMotion, rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[{ width: props.size, height: props.size }, style]}
    >
      <SymbolView
        name={direction === "right" ? "chevron.right" : "chevron.down"}
        size={props.size}
        tintColor={props.tintColor}
        tintColorClassName={props.tintColorClassName}
        type="monochrome"
      />
    </Animated.View>
  );
}
