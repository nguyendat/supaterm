import type { ReactNode } from "react";
import { View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useWorkspaceDockBottomInset } from "./useWorkspaceDockBottomInset";

export function WorkspaceDockFrame(props: {
  readonly floating?: boolean;
  readonly children: ReactNode;
}) {
  const bottomInset = useWorkspaceDockBottomInset();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  if (keyboardVisible) return null;
  return (
    <View
      pointerEvents="box-none"
      className="w-full"
      style={
        props.floating
          ? {
              position: "absolute",
              left: 0,
              right: 0,
              bottom: bottomInset,
              paddingHorizontal: 16,
              zIndex: 5,
            }
          : undefined
      }
    >
      {props.children}
    </View>
  );
}
