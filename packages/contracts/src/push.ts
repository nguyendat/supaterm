import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export function normalizePushGatewayUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const PushGatewayUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value: string) => normalizePushGatewayUrl(value) === value, {
    expected: "an HTTPS origin or a local HTTP origin without credentials",
  }),
);

export const PushDeviceId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export const PushRecipientId = PushDeviceId;
export const PushGeneration = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
export const PushSecret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export const PushNotificationKind = Schema.Literals([
  "approval",
  "input",
  "completion",
  "failure",
  "usage-limit",
]);
export type PushNotificationKind = typeof PushNotificationKind.Type;
export const PushPreferences = Schema.Struct({
  enabled: Schema.Boolean,
  approval: Schema.Boolean,
  input: Schema.Boolean,
  completion: Schema.Boolean,
  failure: Schema.Boolean,
  "usage-limit": Schema.Boolean,
});
export type PushPreferences = typeof PushPreferences.Type;
export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  enabled: false,
  approval: true,
  input: true,
  completion: true,
  failure: true,
  "usage-limit": true,
};

export const PushRegistration = Schema.Struct({
  recipientId: PushRecipientId,
  generation: PushGeneration,
  status: Schema.Literals(["pending", "active", "revoked"]),
  preferences: PushPreferences,
  gatewayUrl: Schema.String,
});
export type PushRegistration = typeof PushRegistration.Type;
export const PushDeviceInput = Schema.Struct({ deviceId: PushDeviceId });
export const PushState = Schema.Struct({
  gatewayUrl: Schema.NullOr(Schema.String),
  registration: Schema.NullOr(PushRegistration),
});
export const PushRegisterInput = Schema.Struct({
  ...PushDeviceInput.fields,
  token: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32,256}$/)),
  topic: Schema.String.check(
    Schema.isMaxLength(256),
    Schema.isPattern(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
  ),
  environment: Schema.Literals(["sandbox", "production"]),
  revocationToken: PushSecret,
  previousRevocationToken: Schema.optionalKey(PushSecret),
  preferences: PushPreferences,
});
export const PushConfirmInput = Schema.Struct({
  ...PushDeviceInput.fields,
  recipientId: PushRecipientId,
  generation: PushGeneration,
  challenge: PushSecret,
});
export const PushPreferencesInput = Schema.Struct({
  ...PushDeviceInput.fields,
  preferences: PushPreferences,
});
export const PushPresenceInput = Schema.Struct({
  ...PushDeviceInput.fields,
  foreground: Schema.Boolean,
  threadId: Schema.NullOr(ThreadId),
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const PushRevokeInput = Schema.Struct({
  ...PushDeviceInput.fields,
  recipientId: PushRecipientId,
  generation: PushGeneration,
  revocationToken: Schema.optionalKey(PushSecret),
});
export const PushResolveInput = Schema.Struct({
  ...PushDeviceInput.fields,
  recipientId: PushRecipientId,
  generation: PushGeneration,
  notificationId: PushRecipientId,
});
export const PushResolvedNotification = Schema.Struct({
  threadId: ThreadId,
  kind: PushNotificationKind,
  sequence: Schema.Number,
});
export const PushNotificationData = Schema.Struct({
  version: Schema.Literal(1),
  recipientId: PushRecipientId,
  generation: PushGeneration,
  notificationId: PushRecipientId,
});
export const PushEnrollmentData = Schema.Struct({
  version: Schema.Literal(1),
  recipientId: PushRecipientId,
  generation: PushGeneration,
  challenge: PushSecret,
});

export class PushNotificationError extends Schema.TaggedError<PushNotificationError>()(
  "PushNotificationError",
  {
    operation: Schema.Literals([
      "state",
      "register",
      "confirm",
      "preferences",
      "revoke",
      "presence",
      "resolve",
      "deliver",
    ]),
    reason: Schema.Literals(["unavailable", "not-found", "rejected", "storage"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "unavailable"
      ? "The notification gateway is unavailable."
      : this.reason === "not-found"
        ? "This notification registration is no longer available."
        : this.reason === "rejected"
          ? "The notification gateway could not accept this request."
          : "Could not save notification state.";
  }
}
