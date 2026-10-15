import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

/**
 * Frame for the preview panel. Its parent owns the size: a `PreviewPanelInline`
 * in inline mode, the sheet or sidebar otherwise.
 */
export function PreviewPanelShell(props: {
  mode: PreviewPanelMode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 max-w-full flex-col self-stretch bg-background",
        props.mode === "inline" && "border-l border-border",
        props.open === false && "pointer-events-none",
      )}
      data-preview-panel-mode={props.mode}
    >
      {props.children}
    </div>
  );
}
