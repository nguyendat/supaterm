import type { MicroMappedAction } from "@supacode/micro/input";
import { LED_COLORS, type MicroThreadStatus } from "@supacode/micro/protocol";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CornerDownLeftIcon,
  FocusIcon,
  GitForkIcon,
  ListFilterIcon,
  XCircleIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ACTION_KEYCAPS = {
  fast: { label: "FAST", icon: ZapIcon },
  approve: { label: "APPR", icon: CheckCircle2Icon },
  reject: { label: "REJ", icon: XCircleIcon },
  fork: { label: "FORK", icon: GitForkIcon },
  send: { label: "SEND", icon: CornerDownLeftIcon },
  focus: { label: "FOCUS", icon: FocusIcon },
  effortMenu: { label: "EFFORT", icon: ListFilterIcon },
} as const;

export function microActionKeycap(action: MicroMappedAction | null) {
  return action ? ACTION_KEYCAPS[action] : { label: "NONE", icon: CircleDashedIcon };
}

export function MicroKeycap({
  label,
  caption,
  icon: Icon,
  led,
  selected,
  shape = "key",
  wide = false,
  onClick,
}: {
  readonly label: string;
  readonly caption?: string;
  readonly icon?: LucideIcon;
  readonly led?: MicroThreadStatus;
  readonly selected?: boolean;
  readonly shape?: "key" | "dial";
  readonly wide?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={selected}
            onClick={onClick}
            className={cn(
              "flex min-w-0 flex-col items-center justify-center gap-2 border border-border/70 bg-background p-2 text-foreground shadow-sm outline-none hover:border-ring/60 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              wide ? "col-span-2" : "aspect-square",
              shape === "dial" ? "rounded-full" : "rounded-xl",
              selected && "border-ring bg-accent/60 ring-1 ring-ring",
            )}
          />
        }
      >
        {led !== undefined ? (
          <span
            className={cn(
              "size-3 rounded-full shadow-sm",
              led === "unavailable" && "bg-muted-foreground/25",
            )}
            style={
              led === "unavailable"
                ? undefined
                : { backgroundColor: "#" + LED_COLORS[led].toString(16).padStart(6, "0") }
            }
            aria-hidden="true"
          />
        ) : Icon ? (
          <Icon className="size-5 shrink-0" aria-hidden="true" />
        ) : null}
        {caption ? (
          <span className="w-full truncate text-center font-mono text-3xs leading-tight sm:text-xs">
            {caption}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
