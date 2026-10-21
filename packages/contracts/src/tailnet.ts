import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
// Mirrors tailcfg.CheckTag: control rejects anything else with an opaque error.
const TAG_PATTERN = /^tag:[A-Za-z][A-Za-z0-9-]*$/u;

export const TailnetHostname = Schema.String.check(
  Schema.makeFilter((value: string) => HOSTNAME_PATTERN.test(value), {
    expected: "a lowercase DNS label of letters, digits, and hyphens, at most 63 characters",
  }),
);
export type TailnetHostname = typeof TailnetHostname.Type;

export const TailnetTag = Schema.String.check(
  Schema.makeFilter((value: string) => TAG_PATTERN.test(value), {
    expected: "a tag such as tag:name, starting with a letter after tag:",
  }),
);
export type TailnetTag = typeof TailnetTag.Type;

export const isTailnetHostname = (value: string) => HOSTNAME_PATTERN.test(value);
export const isTailnetTag = (value: string) => TAG_PATTERN.test(value);

export function normalizeTailnetHostname(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
}

export const TailnetPhase = Schema.Literals([
  "unavailable",
  "signed-out",
  "starting",
  "needs-login",
  "needs-approval",
  "running",
  "needs-reauth",
  "restarting",
  "error",
]);
export type TailnetPhase = typeof TailnetPhase.Type;

export const TailnetHttpsState = Schema.Literals(["pending", "ready", "disabled"]);
export type TailnetHttpsState = typeof TailnetHttpsState.Type;

export const TailnetSelf = Schema.Struct({
  dnsName: Schema.optionalKey(Schema.String),
  ipv4: Schema.optionalKey(Schema.String),
  loginName: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  tagged: Schema.Boolean,
  tags: Schema.Array(Schema.String),
  keyExpiry: Schema.optionalKey(IsoDateTime),
});
export type TailnetSelf = typeof TailnetSelf.Type;

export const TailnetStatus = Schema.Struct({
  phase: TailnetPhase,
  message: Schema.optionalKey(Schema.String),
  suggestedHostname: Schema.String,
  hostname: Schema.optionalKey(Schema.String),
  tags: Schema.Array(Schema.String),
  serveEnabled: Schema.Boolean,
  requireOwner: Schema.Boolean,
  loggingAllowed: Schema.Boolean,
  loggingRequired: Schema.Boolean,
  https: TailnetHttpsState,
  httpsMessage: Schema.optionalKey(Schema.String),
  httpsUrl: Schema.optionalKey(Schema.String),
  httpUrl: Schema.optionalKey(Schema.String),
  self: Schema.optionalKey(TailnetSelf),
});
export type TailnetStatus = typeof TailnetStatus.Type;

export const TailnetSignInInput = Schema.Struct({
  hostname: TailnetHostname,
  tags: Schema.Array(TailnetTag).check(Schema.isMaxLength(16)),
  authKey: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
});
export type TailnetSignInInput = typeof TailnetSignInInput.Type;

export const TailnetLoginResult = Schema.Struct({
  loginUrl: Schema.NullOr(Schema.String),
});
export type TailnetLoginResult = typeof TailnetLoginResult.Type;

export const TailnetConfigureInput = Schema.Struct({
  serveEnabled: Schema.optionalKey(Schema.Boolean),
  requireOwner: Schema.optionalKey(Schema.Boolean),
  hostname: Schema.optionalKey(TailnetHostname),
  loggingAllowed: Schema.optionalKey(Schema.Boolean),
});
export type TailnetConfigureInput = typeof TailnetConfigureInput.Type;

export const TailnetSignOutResult = Schema.Struct({
  remoteLogoutConfirmed: Schema.Boolean,
});
export type TailnetSignOutResult = typeof TailnetSignOutResult.Type;

export const TailnetErrorReason = Schema.Literals([
  "unavailable",
  "not-signed-in",
  "busy",
  "timeout",
  "rejected",
]);
export type TailnetErrorReason = typeof TailnetErrorReason.Type;

export class TailnetError extends Schema.TaggedError<TailnetError>()(
  "TailnetError",
  {
    reason: TailnetErrorReason,
    detail: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    if (this.detail !== undefined) return this.detail;
    switch (this.reason) {
      case "unavailable":
        return "Built-in Tailscale is not available on this machine.";
      case "not-signed-in":
        return "Sign in to Tailscale first.";
      case "busy":
        return "Another Tailscale change is still in progress.";
      case "timeout":
        return "Tailscale did not respond in time. Try again.";
      case "rejected":
        return "Tailscale rejected the request.";
    }
  }
}
