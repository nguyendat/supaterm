import type { DesktopUpdateState } from "@supacode/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { desktopUpdateRestart } from "../../state/desktopUpdateRestart";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  resolveDesktopUpdateIndicator,
  type DesktopUpdateIndicator,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DesktopUpdateStatusIcon } from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

export function shouldUseSidebarUpdateReleaseNotesPopover(state: DesktopUpdateState): boolean {
  return state.channel === "nightly" && state.releaseNotes.length > 0;
}

export function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  // The trigger is the update action, so its presses must not also toggle the Popover.
  if (details.reason === "trigger-press") details.cancel();
}

export function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export function SidebarUpdatePill() {
  return isElectron ? <SidebarUpdateControl /> : null;
}

// Hidden while idle or up to date; manual checks live in Settings and the app menu.
function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const indicator = resolveDesktopUpdateIndicator(state);
  return state && indicator ? <SidebarUpdateButton indicator={indicator} state={state} /> : null;
}

function SidebarUpdateButton({
  indicator,
  state,
}: {
  readonly indicator: DesktopUpdateIndicator;
  readonly state: DesktopUpdateState;
}) {
  const [isActionPending, setIsActionPending] = useState(false);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();

  const isChecking = state.status === "checking";
  const tooltip = isChecking ? "Checking for updates…" : getDesktopUpdateButtonTooltip(state);
  const isInteractionDisabled = isActionPending || isChecking || indicator === "downloading";
  const showReleaseNotesPopover = shouldUseSidebarUpdateReleaseNotesPopover(state);

  useEffect(() => {
    if (!showReleaseNotesPopover) {
      releaseNotesPopoverHandle.close();
      return;
    }

    const trigger = document.getElementById(releaseNotesTriggerId);
    if (trigger?.matches(":focus-visible")) {
      releaseNotesPopoverHandle.open(releaseNotesTriggerId);
    }
  }, [releaseNotesPopoverHandle, releaseNotesTriggerId, showReleaseNotesPopover]);

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || isInteractionDisabled) return;

    setIsActionPending(true);

    if (indicator === "available") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            showDesktopUpdateDownloadedToast(bridge, result.state);
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setIsActionPending(false));
      return;
    }

    let confirmed = false;
    try {
      confirmed = await ensureLocalApi().dialogs.confirm(
        getDesktopUpdateInstallConfirmationMessage(state),
      );
    } catch (error) {
      setIsActionPending(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not confirm update",
          description: error instanceof Error ? error.message : "Update confirmation failed.",
        }),
      );
      return;
    }
    if (!confirmed) {
      setIsActionPending(false);
      return;
    }
    void desktopUpdateRestart
      .install(bridge)
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      })
      .finally(() => setIsActionPending(false));
  }, [indicator, isInteractionDisabled, state]);

  const updateButton = (
    <button
      type="button"
      aria-label={tooltip}
      aria-disabled={isInteractionDisabled || undefined}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        "bg-sidebar-control-surface text-sidebar-foreground",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-sidebar-row-hover",
      )}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
      }}
      onFocus={(event) => {
        if (!showReleaseNotesPopover || !event.currentTarget.matches(":focus-visible")) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showReleaseNotesPopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      <DesktopUpdateStatusIcon downloadPercent={state.downloadPercent} status={indicator} />
    </button>
  );

  return (
    <SidebarMenuItem className="shrink-0">
      <Popover
        handle={releaseNotesPopoverHandle}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
        }}
      >
        <Tooltip disabled={showReleaseNotesPopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showReleaseNotesPopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showReleaseNotesPopover}
                render={updateButton}
              />
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup align="center" side="top" variant="glass">
              {tooltip}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover ? (
          <PopoverPopup
            align="center"
            aria-label="Nightly update release notes"
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side="top"
            tooltipStyle
          >
            <SidebarUpdateReleaseNotes
              shell={window.desktopBridge}
              state={state}
              tooltip={tooltip}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
    </SidebarMenuItem>
  );
}
