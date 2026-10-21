import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

const DOTS = [
  { x: 5, y: 5, lit: false },
  { x: 12, y: 5, lit: false },
  { x: 19, y: 5, lit: false },
  { x: 5, y: 12, lit: true },
  { x: 12, y: 12, lit: true },
  { x: 19, y: 12, lit: true },
  { x: 5, y: 19, lit: false },
  { x: 12, y: 19, lit: true },
  { x: 19, y: 19, lit: false },
];

function TailscaleMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      {DOTS.map((dot) => (
        <circle
          key={`${dot.x}:${dot.y}`}
          cx={dot.x}
          cy={dot.y}
          r={2.6}
          opacity={dot.lit ? 1 : 0.32}
        />
      ))}
    </svg>
  );
}

export function TailscaleLogo({ size = "default" }: { readonly size?: "default" | "lg" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-background text-foreground shadow-xs/5 ring-1 ring-border",
        size === "lg" ? "size-11" : "size-9",
      )}
    >
      <TailscaleMark className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}
