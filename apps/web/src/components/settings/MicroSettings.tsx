import { getMicroController, useMicro } from "@supacode/micro/react";
import { MICRO_ACTIONS, type MicroMappedAction } from "@supacode/micro/input";
import { useState } from "react";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import { InlineConfirmButton } from "../InlineConfirm";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { MicroKeyboard, type MicroEditTarget } from "./MicroKeyboard";
import { MicroKeyEditor, type MicroKeyUpdate } from "./MicroKeyEditor";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const CONNECTION_LABELS = {
  connected: "Connected",
  disconnected: "Disconnected",
  connecting: "Connecting…",
  disconnecting: "Disconnecting…",
  unsupported: "Unavailable",
  error: "Connection failed",
} as const;

export function MicroSettings() {
  const snapshot = useMicro();
  const micro = getMicroController();
  const needsInputMonitoring = window.desktopBridge?.getClientPlatform?.() === "darwin";
  const permission = usePermissionStatus(
    async () => ({
      inputMonitoring:
        (await window.desktopBridge?.checkSystemPermission?.("input-monitoring")) ?? false,
    }),
    { inputMonitoring: false },
    needsInputMonitoring,
  );
  const [editing, setEditing] = useState<MicroEditTarget | null>(null);
  const save = (operation: () => void) => {
    try {
      operation();
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save Micro settings",
        description: error instanceof Error ? error.message : "Browser storage is unavailable.",
      });
      return false;
    }
  };
  const saveKey = (update: MicroKeyUpdate) =>
    save(() => {
      if (update.kind === "agent") micro.assign(update.slot, update.assignment);
      else if (update.kind === "command") micro.setKeyAction(update.key, update.action);
      else micro.setMicrophone(update.action);
    });
  const connected = snapshot.phase === "connected";
  return (
    <SettingsPageContainer>
      <SettingsSection id="micro-controller" title="Connection">
        <SettingsRow
          title="Codex Micro"
          description={
            snapshot.error ??
            (connected
              ? (snapshot.productName ?? "Micro") +
                (snapshot.transport ? " · " + snapshot.transport : "") +
                (snapshot.firmware ? " · Firmware " + snapshot.firmware : "")
              : "Connect with USB or pair your Micro in system Bluetooth settings, then press Connect.")
          }
          control={
            <div className="flex items-center gap-3">
              <span role="status" className="text-xs text-muted-foreground">
                {CONNECTION_LABELS[snapshot.phase]}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={snapshot.phase === "unsupported" || snapshot.phase === "disconnecting"}
                onClick={() => {
                  void (connected || snapshot.phase === "connecting"
                    ? micro.disconnect()
                    : micro.connect());
                }}
              >
                {connected ? "Disconnect" : snapshot.phase === "connecting" ? "Cancel" : "Connect"}
              </Button>
            </div>
          }
        />
        {needsInputMonitoring ? (
          <SettingsRow
            title="Input Monitoring"
            description={
              permission.error ??
              "Required to read Micro keys on macOS. Restart Supacode after granting access."
            }
            control={
              permission.status.inputMonitoring ? (
                <span className="text-sm text-muted-foreground">Granted</span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void window.desktopBridge
                      ?.openSystemSettings?.("input-monitoring")
                      .catch(() => {
                        toastManager.add({
                          type: "error",
                          title: "Could not open System Settings",
                        });
                      });
                  }}
                >
                  Open System Settings
                </Button>
              )
            }
          />
        ) : null}
        {snapshot.phase === "unsupported" ? (
          <SettingsRow
            title="Device access unavailable"
            description="Device access is unavailable in this desktop app."
          />
        ) : null}
      </SettingsSection>
      <SettingsSection
        id="micro-layout"
        title="Layout"
        variant="plain"
        headerAction={
          <InlineConfirmButton
            size="xs"
            variant="ghost-muted"
            label="Reset layout"
            confirmLabel="Restore defaults"
            tooltip="Restore factory command actions and clear the microphone action."
            confirmTooltip="Restore the default key actions?"
            onConfirm={() => {
              save(() => micro.resetLayout());
            }}
          />
        }
      >
        <MicroKeyboard config={snapshot.config} onEdit={setEditing} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Click a key to change its assignment. The six Agent Keys keep their assigned threads.
        </p>
      </SettingsSection>
      <SettingsSection id="micro-options" title="Options">
        <SettingsRow
          title="Agent Keys"
          description="Assign each key to a local or remote thread in the layout above."
          control={<span className="text-sm text-muted-foreground">Fixed assignments</span>}
        />
        <SettingsRow
          title="Dial"
          description="Turn to change the next prompt’s supported reasoning effort. Click the dial in the layout to choose its press action."
          control={<span className="text-sm text-muted-foreground">Reasoning effort</span>}
        />
        <SettingsRow
          title="Microphone key"
          description="The wide key triggers one action. Voice recording is not available here yet."
          control={
            <Select
              value={snapshot.config.microphone ?? "none"}
              onValueChange={(value) => {
                if (value === "none") save(() => micro.setMicrophone(null));
                else if (value && Object.hasOwn(MICRO_ACTIONS, value))
                  save(() => micro.setMicrophone(value as MicroMappedAction));
              }}
            >
              <SelectTrigger size="sm" aria-label="Microphone key action">
                <SelectValue>
                  {snapshot.config.microphone
                    ? MICRO_ACTIONS[snapshot.config.microphone]
                    : "Unassigned"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="none">Unassigned</SelectItem>
                {Object.entries(MICRO_ACTIONS).map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      {editing ? (
        <MicroKeyEditor
          target={editing}
          config={snapshot.config}
          onSave={saveKey}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
