import { getMicroController, useMicro } from "@supacode/micro/react";
import { MICRO_SLOTS } from "@supacode/micro/protocol";
import { ACTION_KEY_LABELS, MICRO_ACTIONS, type MicroMappedAction } from "@supacode/micro/input";
import { useMemo } from "react";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function MicroSettings() {
  const snapshot = useMicro();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const micro = getMicroController();
  const choices = useMemo(
    () =>
      threads
        .filter((thread) => thread.archivedAt === null)
        .map((thread) => ({
          value: JSON.stringify([thread.environmentId, thread.id]),
          thread,
          label: `${thread.title} · ${environments.find((environment) => environment.environmentId === thread.environmentId)?.label ?? "Environment"}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [threads, environments],
  );
  const save = (operation: () => void) => {
    try {
      operation();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save Micro settings",
        description: error instanceof Error ? error.message : "Browser storage is unavailable.",
      });
    }
  };
  const connected = snapshot.phase === "connected";
  return (
    <SettingsSection id="micro-controller" title="Micro controller">
      <SettingsRow
        title="Codex Micro"
        description={
          snapshot.error ??
          (connected
            ? `${snapshot.productName ?? "Micro"}${snapshot.firmware ? ` · Firmware ${snapshot.firmware}` : ""}`
            : "Connect your Work Louder Micro to control Supacode.")
        }
        control={
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
        }
      />
      {snapshot.phase === "unsupported" ? (
        <SettingsRow
          title="Device access unavailable"
          description="Use the desktop app or a browser with WebHID support."
        />
      ) : null}
      {MICRO_SLOTS.map((slot) => {
        const assignment = snapshot.config.slots[slot];
        const value = assignment
          ? JSON.stringify([assignment.environmentId, assignment.threadId])
          : "none";
        const selected = choices.find((choice) => choice.value === value);
        return (
          <SettingsRow
            key={slot}
            title={`Agent Key ${slot + 1}`}
            description="Keeps its assigned thread when the sidebar order changes."
            control={
              <Select
                value={value}
                onValueChange={(next) => {
                  const choice = choices.find((candidate) => candidate.value === next);
                  if (next !== "none" && !choice) return;
                  save(() =>
                    micro.assign(
                      slot,
                      choice
                        ? { environmentId: choice.thread.environmentId, threadId: choice.thread.id }
                        : null,
                    ),
                  );
                }}
              >
                <SelectTrigger size="sm" aria-label={`Assign Agent Key ${slot + 1}`}>
                  <SelectValue>
                    {selected?.label ?? (assignment ? "Thread unavailable" : "Unassigned")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  <SelectItem value="none">Unassigned</SelectItem>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
      <SettingsRow title="Command keys" description={ACTION_KEY_LABELS.join(" · ")} />
      <SettingsRow
        title="Dial and joystick"
        description="Turn the dial to change reasoning effort. Press it for the effort menu. The joystick opens effort, model, host, or workspace controls."
      />
      <SettingsRow
        title="Microphone key"
        description="Choose an action for the wide key. Voice recording is not available here yet."
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
  );
}
