import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WORKSPACE_DOCK } from "./workspace-tabs-state";

export function useWorkspaceDockBottomInset() {
  const insets = useSafeAreaInsets();
  return Math.max(insets.bottom, 12) + WORKSPACE_DOCK.bottomGap;
}
