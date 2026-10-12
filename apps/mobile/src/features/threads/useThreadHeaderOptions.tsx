import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform } from "react-native";
import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { dispatchHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useStartNewTask } from "./use-start-new-task";
import { ThreadGitControls, useThreadGitRightHeaderItems } from "./ThreadGitControls";

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

export function useThreadHeaderOptions(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly headerColor: string;
  readonly usesNativeHeaderGlass: boolean;
  readonly gitControls: Parameters<typeof ThreadGitControls>[0];
  readonly onReturnToThread?: () => void;
}) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const usesDuoHeader = usesNativeWorkspaceColumns && Platform.OS === "ios" && !Platform.isPad;
  const navigation = useNavigation();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const startNewTask = useStartNewTask();
  const rightHeaderItems = useThreadGitRightHeaderItems(props.gitControls);
  const splitLeftHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      ...(!usesDuoHeader
        ? [
            {
              // Match Mail's split-view detail toolbar: the first detail action sits
              // inside the content pane, not flush against the sidebar divider.
              spacing: 18,
              type: "spacing" as const,
            },
          ]
        : []),
      ...(props.onReturnToThread
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Return to chat",
              icon: { name: "chevron.left", type: "sfSymbol" as const },
              identifier: "thread-left-return",
              onPress: props.onReturnToThread,
              type: "button" as const,
            }),
          ]
        : []),
      withNativeGlassHeaderItem({
        axisBehavior: usesNativeWorkspaceColumns ? "horizontalOnly" : undefined,
        accessibilityLabel: panes.primarySidebarVisible
          ? "Maximize content"
          : "Show thread sidebar",
        icon: {
          name: panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
          type: "sfSymbol" as const,
        },
        identifier: "thread-left-sidebar",
        label: panes.primarySidebarVisible ? "Maximize content" : "Show thread sidebar",
        onPress: togglePrimarySidebar,
        type: "button" as const,
      }),
      ...(!usesDuoHeader
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "New task",
              icon: { name: "square.and.pencil", type: "sfSymbol" as const },
              identifier: "thread-left-new-task",
              label: "New task",
              onPress: startNewTask,
              type: "button" as const,
            }),
          ]
        : []),
    ],
    [
      panes.primarySidebarVisible,
      props.onReturnToThread,
      startNewTask,
      togglePrimarySidebar,
      usesDuoHeader,
      usesNativeWorkspaceColumns,
    ],
  );
  // Deep links / cold starts land with Thread as the ONLY route, where the
  // native back button does not render. Provide an explicit Home escape for
  // that case; when history exists the native back button is used instead.
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      withNativeGlassHeaderItem({
        accessibilityLabel: "Go to threads list",
        icon: { name: "list.bullet", type: "sfSymbol" as const },
        identifier: "thread-left-home",
        onPress: () => navigation.dispatch(StackActions.replace("Home")),
        type: "button" as const,
      }),
    ],
    [navigation],
  );

  const duoRightHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      ...rightHeaderItems,
      { type: "spacing", spacing: 8 },
      ...(layout.usesSplitView &&
      Platform.OS === "ios" &&
      !Platform.isPad &&
      !panes.primarySidebarVisible
        ? [
            withNativeGlassHeaderItem({
              type: "button" as const,
              axisBehavior: "verticalPreferred",
              identifier: "thread-right-search",
              label: "Search threads",
              accessibilityLabel: "Search threads",
              icon: { name: "magnifyingglass", type: "sfSymbol" as const },
              onPress: () => {
                dispatchHardwareKeyboardCommand("focusSearch");
              },
            }),
          ]
        : []),
      withNativeGlassHeaderItem({
        type: "button" as const,
        axisBehavior: "verticalPreferred",
        identifier: "thread-right-new-task",
        label: "New task",
        accessibilityLabel: "New task",
        icon: { name: "square.and.pencil", type: "sfSymbol" as const },
        onPress: startNewTask,
      }),
    ],
    [rightHeaderItems, layout.usesSplitView, panes.primarySidebarVisible, startNewTask],
  );

  const options: AppNativeStackNavigationOptions = {
    headerShown: true,
    headerTitle: props.title,
    title: props.title,
    headerBackVisible: !layout.usesSplitView,
    // Compact uses the NATIVE back button when a previous route exists;
    // deep links / cold starts get an explicit Home button instead.
    // Split view always uses its custom left items.
    unstable_headerLeftItems: layout.usesSplitView
      ? () => splitLeftHeaderItems
      : canGoBack
        ? undefined
        : () => compactHomeHeaderItems,
    unstable_headerRightItems: () => (usesDuoHeader ? duoRightHeaderItems : rightHeaderItems),
    unstable_headerToolbarItems: () => [],
    unstable_headerSubtitle: props.usesNativeHeaderGlass ? props.subtitle : undefined,
    contentStyle: undefined,
  };
  const { environmentId, threadId, gitStatus } = props.gitControls;
  return {
    options,

    optionsVersion: [
      splitLeftHeaderItems,
      rightHeaderItems,
      duoRightHeaderItems,
      usesDuoHeader,
      environmentId,
      threadId,
      gitStatus?.isDefaultRef,
      gitStatus?.refName,
      gitStatus?.pr?.url,
    ],
    sidebar: false,
    fallback:
      !layout.usesSplitView && !props.usesNativeHeaderGlass ? (
        <ThreadGitControls {...props.gitControls} showActionControls />
      ) : null,
  };
}
