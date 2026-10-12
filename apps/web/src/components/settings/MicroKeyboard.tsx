import type { MicroConfig } from "@supacode/micro/controller";
import { MICRO_ACTIONS, resolveMicroKeyAction, type MicroCommandKey } from "@supacode/micro/input";
import { MICRO_SLOTS } from "@supacode/micro/protocol";
import { resolveMicroThreadStatus } from "@supacode/micro/status";
import { isEnvironmentConnected } from "@supacode/client-runtime/connection";
import { MoveIcon, MicIcon } from "lucide-react";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import type { MicroThreadChoice } from "./MicroKeyEditor";
import { MicroKeycap, microActionKeycap } from "./MicroKeycap";

export type MicroEditTarget =
  | { readonly kind: "agent"; readonly slot: number }
  | { readonly kind: "command"; readonly key: MicroCommandKey }
  | { readonly kind: "microphone" }
  | { readonly kind: "joystick" };

function AgentKey({
  slot,
  choice,
  assigned,
  onEdit,
}: {
  readonly slot: number;
  readonly choice: MicroThreadChoice | undefined;
  readonly assigned: boolean;
  readonly onEdit: (target: MicroEditTarget) => void;
}) {
  const thread = useThreadShell(choice?.ref ?? null);
  const { presentation } = useEnvironmentPresentation(choice?.ref.environmentId ?? null);
  const status = resolveMicroThreadStatus(thread, isEnvironmentConnected(presentation));
  const title = choice?.title ?? (assigned ? "Unavailable" : "Unassigned");
  return (
    <MicroKeycap
      label={"Assign Agent Key " + (slot + 1) + ": " + title}
      caption={choice ? slot + 1 + " · " + title : String(slot + 1)}
      led={status}
      onClick={() => onEdit({ kind: "agent", slot })}
    />
  );
}

export function MicroKeyboard({
  config,
  choices,
  onEdit,
}: {
  readonly config: MicroConfig;
  readonly choices: readonly MicroThreadChoice[];
  readonly onEdit: (target: MicroEditTarget) => void;
}) {
  const agentKey = (slot: number) => {
    const assignment = config.slots[slot];
    return (
      <AgentKey
        key={slot}
        slot={slot}
        assigned={assignment != null}
        choice={choices.find(
          (choice) =>
            choice.ref.environmentId === assignment?.environmentId &&
            choice.ref.threadId === assignment?.threadId,
        )}
        onEdit={onEdit}
      />
    );
  };
  const commandKey = (key: MicroCommandKey, dial = false) => {
    const action = resolveMicroKeyAction(key, config.keyBindings);
    const keycap = microActionKeycap(action);
    return (
      <MicroKeycap
        key={key}
        label={
          (dial ? "Edit dial press" : "Edit " + key) +
          " action: " +
          (action ? MICRO_ACTIONS[action] : "Unassigned")
        }
        caption={keycap.label}
        icon={keycap.icon}
        shape={dial ? "dial" : "key"}
        onClick={() => onEdit({ kind: "command", key })}
      />
    );
  };
  return (
    <div className="flex justify-center rounded-xl border border-border/60 bg-card/40 p-6 sm:p-8">
      <div
        className="grid w-full max-w-[22rem] grid-cols-4 gap-2 rounded-2xl border border-border/60 bg-muted/60 p-3"
        role="group"
        aria-label="Micro keyboard layout"
      >
        {commandKey("ENC_CLK", true)}
        {agentKey(0)}
        {agentKey(1)}
        <MicroKeycap
          label="View joystick controls"
          icon={MoveIcon}
          caption="NAV"
          onClick={() => onEdit({ kind: "joystick" })}
        />
        {MICRO_SLOTS.slice(2).map(agentKey)}
        {(["ACT06", "ACT07", "ACT08", "ACT09"] as const).map((key) => commandKey(key))}
        <div
          className="flex aspect-square items-center justify-center gap-1.5"
          role="img"
          aria-label="Layer and host touch sensor"
        >
          <span className="size-1.5 rounded-full bg-muted-foreground/35" />
          <span className="size-8 rounded-full border border-border/60 bg-foreground/80" />
        </div>
        <MicroKeycap
          label={
            "Edit microphone key action: " +
            (config.microphone ? MICRO_ACTIONS[config.microphone] : "Unassigned")
          }
          icon={config.microphone ? microActionKeycap(config.microphone).icon : MicIcon}
          caption={config.microphone ? microActionKeycap(config.microphone).label : "MIC"}
          wide
          onClick={() => onEdit({ kind: "microphone" })}
        />
        {commandKey("ACT12")}
      </div>
    </div>
  );
}
