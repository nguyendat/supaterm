import {
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
