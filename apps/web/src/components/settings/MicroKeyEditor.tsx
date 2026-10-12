import type { ScopedThreadRef } from "@supacode/contracts";
import type { MicroConfig, ThreadAssignment } from "@supacode/micro/controller";
import {
  MICRO_ACTIONS,
  resolveMicroKeyAction,
  type MicroMappedAction,
  type MicroCommandKey,
} from "@supacode/micro/input";
import { useState } from "react";
import { normalizeSearchText } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { MicroEditTarget } from "./MicroKeyboard";
import { MicroKeycap, microActionKeycap } from "./MicroKeycap";

export interface MicroThreadChoice {
  readonly ref: ScopedThreadRef;
  readonly value: string;
  readonly title: string;
  readonly label: string;
}

export type MicroKeyUpdate =
  | { readonly kind: "agent"; readonly slot: number; readonly assignment: ThreadAssignment | null }
  | {
      readonly kind: "command";
      readonly key: MicroCommandKey;
      readonly action: MicroMappedAction | null;
    }
  | { readonly kind: "microphone"; readonly action: MicroMappedAction | null };

const ACTION_CHOICES = [
  { value: null, label: "Unassigned" },
  ...Object.entries(MICRO_ACTIONS).map(([value, label]) => ({
    value: value as MicroMappedAction,
    label,
  })),
];
const JOYSTICK_CONTROLS = [
  ["Up", "Reasoning effort"],
  ["Right", "Model"],
  ["Down", "Host"],
  ["Left", "Workspace"],
];

export function MicroKeyEditor({
  target,
  config,
  choices,
  onSave,
  onClose,
}: {
  readonly target: MicroEditTarget;
  readonly config: MicroConfig;
  readonly choices: readonly MicroThreadChoice[];
  readonly onSave: (update: MicroKeyUpdate) => boolean;
  readonly onClose: () => void;
}) {
  const [action, setAction] = useState<MicroMappedAction | null>(() => {
    if (target.kind === "command") return resolveMicroKeyAction(target.key, config.keyBindings);
    return config.microphone;
  });
  const assignment = target.kind === "agent" ? config.slots[target.slot] : null;
  const [threadValue, setThreadValue] = useState(
    assignment ? JSON.stringify([assignment.environmentId, assignment.threadId]) : "none",
  );
  const [query, setQuery] = useState("");
  const selectedThread = choices.find((choice) => choice.value === threadValue);
  const normalizedQuery = normalizeSearchText(query);
  const filtered = ACTION_CHOICES.filter((choice) =>
    normalizeSearchText(choice.label).includes(normalizedQuery),
  );
  const save = () => {
    let update: MicroKeyUpdate;
    if (target.kind === "agent") {
      if (threadValue !== "none" && !selectedThread) return;
      update = { kind: "agent", slot: target.slot, assignment: selectedThread?.ref ?? null };
    } else if (target.kind === "command") update = { kind: "command", key: target.key, action };
    else if (target.kind === "microphone") update = { kind: "microphone", action };
    else return;
    if (onSave(update)) onClose();
  };
  let title = "Edit key";
  let description = "Choose what this key does in Supacode.";
  if (target.kind === "agent") {
    title = "Agent Key " + (target.slot + 1);
    description =
      "Choose the thread this key opens. Its assignment stays fixed when the sidebar order changes.";
  } else if (target.kind === "joystick") {
    title = "Joystick controls";
    description = "Move the joystick to open a composer control.";
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {target.kind === "agent" ? (
            <Select
              value={threadValue}
              onValueChange={(value) => {
                if (value) setThreadValue(value);
              }}
            >
              <SelectTrigger aria-label="Assigned thread">
                <SelectValue>
                  {selectedThread?.label ??
                    (threadValue === "none" ? "Unassigned" : "Thread unavailable")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="none">Unassigned</SelectItem>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : target.kind === "joystick" ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              {JOYSTICK_CONTROLS.map(([direction, control]) => (
                <div key={direction} className="contents">
                  <dt className="text-muted-foreground">{direction}</dt>
                  <dd>{control}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <>
              <Input
                type="search"
                aria-label="Search actions"
                placeholder="Search actions"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <div
                className="grid grid-cols-3 gap-3 sm:grid-cols-4"
                role="group"
                aria-label="Key action"
              >
                {filtered.map((choice) => {
                  const keycap = microActionKeycap(choice.value);
                  return (
                    <MicroKeycap
                      key={choice.value ?? "none"}
                      label={choice.label}
                      caption={keycap.label}
                      icon={keycap.icon}
                      selected={action === choice.value}
                      onClick={() => setAction(choice.value)}
                    />
                  );
                })}
              </div>
              {filtered.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground">No actions found.</p>
              ) : null}
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 p-4 text-sm">
                <span className="text-muted-foreground">Assigned action</span>
                <span>{action ? MICRO_ACTIONS[action] : "Unassigned"}</span>
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {target.kind === "joystick" ? "Done" : "Cancel"}
          </Button>
          {target.kind !== "joystick" ? (
            <Button
              onClick={save}
              disabled={target.kind === "agent" && threadValue !== "none" && !selectedThread}
            >
              Save
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
