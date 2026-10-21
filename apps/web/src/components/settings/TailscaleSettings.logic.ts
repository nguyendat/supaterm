import {
  type TailnetConfigureInput,
  type TailnetSelf,
  type TailnetStatus,
  isTailnetHostname,
  isTailnetTag,
} from "@supaterm/contracts";

export const TAILSCALE_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";

const KEY_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseTailnetTagsInput(value: string) {
  const entries = [...new Set(value.split(/[\s,]+/u).filter((entry) => entry.length > 0))];
  return {
    tags: entries.filter(isTailnetTag),
    invalid: entries.filter((entry) => !isTailnetTag(entry)),
  };
}

export function tailnetHostnameError(value: string): string | null {
  if (value.length === 0) return "Enter a hostname.";
  if (isTailnetHostname(value)) return null;
  return "Use lowercase letters, digits, and hyphens, up to 63 characters, without a leading or trailing hyphen.";
}

export function tailnetAddress(status: Pick<TailnetStatus, "httpsUrl" | "httpUrl">) {
  return status.httpsUrl ?? status.httpUrl ?? null;
}

export function tailnetAccountSummary(self: TailnetSelf | undefined): string | null {
  if (self === undefined) return null;
  if (self.tagged) {
    return self.tags.length > 0 ? `Tagged device · ${self.tags.join(", ")}` : "Tagged device";
  }
  return self.loginName === undefined ? null : `Signed in as ${self.loginName}`;
}

function originOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The page reached this server through the built-in node, so cutting that node off disconnects it. */
export function isTailnetOrigin(
  origin: string,
  status: Pick<TailnetStatus, "httpsUrl" | "httpUrl">,
): boolean {
  return origin === originOf(status.httpsUrl) || origin === originOf(status.httpUrl);
}

/** Plain-HTTP tailnet pages lose secure-context browser features that the HTTPS address keeps. */
export function secureTailnetAddressFor(input: {
  readonly origin: string;
  readonly isSecureContext: boolean;
  readonly status: Pick<TailnetStatus, "httpsUrl" | "httpUrl">;
}): string | null {
  const { origin, isSecureContext, status } = input;
  if (isSecureContext || status.httpsUrl === undefined) return null;
  return origin === originOf(status.httpUrl) ? status.httpsUrl : null;
}

export function tailnetKeyExpiryDays(keyExpiry: string | undefined, nowMs: number): number | null {
  if (keyExpiry === undefined) return null;
  const expiresAt = new Date(keyExpiry).getTime();
  if (Number.isNaN(expiresAt)) return null;
  const days = Math.ceil((expiresAt - nowMs) / DAY_MS);
  return days >= 0 && days <= KEY_EXPIRY_WARNING_DAYS ? days : null;
}

export function tailnetConfirmationMessage(
  question: string,
  ...details: ReadonlyArray<string | null>
): string {
  return [question, ...details.filter((detail) => detail !== null)].join("\n");
}

export type TailnetOperation =
  | { readonly kind: "sign-in" | "cancel-sign-in" | "reauthenticate" | "sign-out" }
  | { readonly kind: "configure"; readonly patch: TailnetConfigureInput };
export type TailnetOperationKind = TailnetOperation["kind"];

/** The server runs one Tailscale change at a time, and cancelling is how a waiting sign-in ends. */
export function canStartTailnetOperation(
  active: TailnetOperation | null,
  kind: TailnetOperationKind,
): boolean {
  return active === null || (active.kind === "sign-in" && kind === "cancel-sign-in");
}

/** A cancel can overlap the sign-in it ends, so the newest operation still in flight is the active one. */
export function activeTailnetOperation(
  inFlight: ReadonlyArray<TailnetOperation>,
): TailnetOperation | null {
  return inFlight[inFlight.length - 1] ?? null;
}

export type TailnetAccountAction =
  | "sign-in"
  | "sign-out"
  | "cancel-sign-in"
  | "continue"
  | "reauthenticate";

export interface TailnetStatusHeader {
  readonly title: string;
  readonly description: string;
  readonly warning?: string | undefined;
  readonly actions: ReadonlyArray<TailnetAccountAction>;
}

function keyExpiryWarning(days: number) {
  const unit = days === 1 ? "day" : "days";
  return `This device's Tailscale key expires in ${days} ${unit}. You can turn off key expiry for it in the Tailscale admin console.`;
}

export function tailnetStatusHeader(
  status: TailnetStatus,
  machineLabel: string,
  nowMs: number,
): TailnetStatusHeader {
  const accountSummary = tailnetAccountSummary(status.self);
  switch (status.phase) {
    case "unavailable":
      return {
        title: "Tailscale is unavailable",
        description: status.message ?? "Built-in Tailscale isn't available on this machine.",
        actions: [],
      };
    case "signed-out":
      return {
        title: "Sign in to Tailscale",
        description: "Access Supaterm securely from your other devices.",
        actions: ["sign-in"],
      };
    case "starting":
      return {
        title: "Starting Tailscale…",
        description: `Connecting ${machineLabel} to your tailnet.`,
        actions: ["sign-out"],
      };
    case "restarting":
      return {
        title: "Restarting Tailscale…",
        description:
          status.message ?? "Tailscale stopped unexpectedly. Supaterm is starting it again.",
        actions: ["sign-out"],
      };
    case "needs-login":
      return {
        title: "Finish signing in to Tailscale",
        description: status.message ?? `Open the sign-in page to connect ${machineLabel}.`,
        actions: ["cancel-sign-in", "continue"],
      };
    case "needs-approval":
      return {
        title: "Waiting for approval",
        description: "Waiting for an admin to approve this device",
        actions: ["cancel-sign-in"],
      };
    case "needs-reauth":
      return {
        title: "Sign in to Tailscale again",
        description: accountSummary ?? "This device's Tailscale sign-in expired.",
        warning:
          status.message ?? "Supaterm isn't reachable over Tailscale until you reauthenticate.",
        actions: ["sign-out", "reauthenticate"],
      };
    case "running": {
      const keyExpiryDays = tailnetKeyExpiryDays(status.self?.keyExpiry, nowMs);
      return {
        title: "Signed in to Tailscale",
        description: accountSummary ?? "Connected to your tailnet.",
        warning:
          status.message ?? (keyExpiryDays === null ? undefined : keyExpiryWarning(keyExpiryDays)),
        actions: ["sign-out"],
      };
    }
    case "error":
      return {
        title: "Tailscale stopped",
        description: status.message ?? "Tailscale couldn't start.",
        actions: ["sign-out"],
      };
  }
}
