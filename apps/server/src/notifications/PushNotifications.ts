import { ThreadId, type AuthSessionId } from "@supacode/contracts";
import {
  PushNotificationError,
  PushRegistration,
  PushPreferences,
  type PushState,
  type PushRegisterInput,
  type PushConfirmInput,
  type PushPreferencesInput,
  type PushPresenceInput,
  type PushResolveInput,
  type PushRevokeInput,
  type PushResolvedNotification,
} from "@supacode/contracts/push";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PushGateway from "./PushGateway.ts";
import * as PushPreview from "./PushPreview.ts";

interface RegistrationRow {
  readonly recipient_id: string;
  readonly session_id: AuthSessionId;
  readonly generation: number;
  readonly status: PushRegistration["status"];
  readonly token_hash: string;
  readonly gateway_url: string;
  readonly preferences_json: string;
  readonly preview_key_json: string | null;
}

export class PushNotifications extends Context.Service<
  PushNotifications,
  {
    readonly state: (
      session: AuthSessionId,
      deviceId: string,
    ) => Effect.Effect<typeof PushState.Type, PushNotificationError>;
    readonly register: (
      session: AuthSessionId,
      input: typeof PushRegisterInput.Type,
    ) => Effect.Effect<PushRegistration, PushNotificationError>;
    readonly confirm: (
      session: AuthSessionId,
      input: typeof PushConfirmInput.Type,
    ) => Effect.Effect<PushRegistration, PushNotificationError>;
    readonly preferences: (
      session: AuthSessionId,
      input: typeof PushPreferencesInput.Type,
    ) => Effect.Effect<PushRegistration, PushNotificationError>;
    readonly revoke: (
      session: AuthSessionId,
      input: typeof PushRevokeInput.Type,
    ) => Effect.Effect<void, PushNotificationError>;
    readonly presence: (
      session: AuthSessionId,
      input: typeof PushPresenceInput.Type,
    ) => Effect.Effect<void, PushNotificationError>;
    readonly resolve: (
      session: AuthSessionId,
      input: typeof PushResolveInput.Type,
    ) => Effect.Effect<typeof PushResolvedNotification.Type, PushNotificationError>;
  }
>()("supacode/notifications/PushNotifications") {}

const decodePreferences = Schema.decodeUnknownSync(Schema.fromJsonString(PushPreferences));
const encodePreferences = Schema.encodeEffect(Schema.fromJsonString(PushPreferences));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isPushNotificationError = Schema.is(PushNotificationError);
const decodeRegistration = Schema.decodeUnknownSync(PushRegistration);
const fromRow = (row: RegistrationRow) =>
  decodeRegistration({
    recipientId: row.recipient_id,
    generation: row.generation,
    status: row.status,
    preferences: decodePreferences(row.preferences_json),
    gatewayUrl: row.gateway_url,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;
  const gateway = yield* PushGateway.PushGateway;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const preview = yield* PushPreview.PushPreview;
  const read = (session: AuthSessionId, deviceId: string) =>
    sql<RegistrationRow>`SELECT * FROM push_registrations WHERE session_id = ${session} AND device_id = ${deviceId}`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const secretHash = (secret: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(secret))
      .pipe(Effect.map((digest) => Buffer.from(digest).toString("hex")));
  const readBySecret = (deviceId: string, hash: string) =>
    sql<RegistrationRow>`SELECT * FROM push_registrations WHERE device_id = ${deviceId} AND revocation_hash = ${hash}`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const requireRegistration = Effect.fnUntraced(function* (
    session: AuthSessionId,
    deviceId: string,
    operation: PushNotificationError["operation"],
  ) {
    const row = yield* read(session, deviceId);
    if (row === undefined)
      return yield* new PushNotificationError({ operation, reason: "not-found" });
    return row;
  });
  const mapError = (operation: PushNotificationError["operation"]) =>
    Effect.mapError((cause: unknown) =>
      isPushNotificationError(cause)
        ? cause
        : new PushNotificationError({ operation, reason: "storage", cause }),
    );
  const gatewayError = (operation: PushNotificationError["operation"]) =>
    Effect.mapError(
      (cause: PushGateway.PushGatewayRequestError) =>
        new PushNotificationError({ operation, reason: cause.reason, cause }),
    );

  const state = Effect.fn("PushNotifications.state")(function* (
    session: AuthSessionId,
    deviceId: string,
  ) {
    const row = yield* read(session, deviceId);
    const configuration = yield* settings.getSettings;
    return {
      gatewayUrl: configuration.pushGatewayUrl,
      registration: row === undefined ? null : fromRow(row),
      hostSigningKey: yield* preview.hostSigningKey,
    };
  }, mapError("state"));

  const register = Effect.fn("PushNotifications.register")(function* (
    session: AuthSessionId,
    input: typeof PushRegisterInput.Type,
  ) {
    const configuration = yield* settings.getSettings;
    const url = configuration.pushGatewayUrl;
    if (url === null)
      return yield* new PushNotificationError({ operation: "register", reason: "unavailable" });
    const fingerprintInput = yield* encodeJson([
      input.token,
      input.topic,
      input.environment,
      input.revocationToken,
      input.previewKey ?? null,
    ]);
    const preferencesJson = yield* encodePreferences(input.preferences);
    const previewKeyJson =
      input.previewKey === undefined ? null : yield* encodeJson(input.previewKey);
    if (input.preferences.previews && input.previewKey === undefined)
      return yield* new PushNotificationError({ operation: "register", reason: "rejected" });
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(fingerprintInput));
    const fingerprint = Buffer.from(digest).toString("hex");
    const revocationHash = yield* secretHash(input.revocationToken);
    const previousHash =
      input.previousRevocationToken === undefined
        ? undefined
        : yield* secretHash(input.previousRevocationToken);
    const row = yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* read(session, input.deviceId);
        const proven =
          (yield* readBySecret(input.deviceId, revocationHash)) ??
          (previousHash === undefined
            ? undefined
            : yield* readBySecret(input.deviceId, previousHash));
        if (
          current !== undefined &&
          proven !== undefined &&
          current.recipient_id !== proven.recipient_id
        )
          return yield* new PushNotificationError({ operation: "register", reason: "rejected" });
        const prior = proven ?? current;
        const same =
          prior !== undefined &&
          prior.session_id === session &&
          prior.status !== "revoked" &&
          prior.token_hash === fingerprint &&
          prior.gateway_url === url;
        const recipientId = prior?.recipient_id ?? (yield* crypto.randomUUIDv4);
        const generation = same ? prior.generation : (prior?.generation ?? 0) + 1;
        if (prior === undefined) {
          yield* sql`
            INSERT INTO push_registrations(recipient_id, session_id, device_id, generation, status, token_hash, revocation_hash, topic, environment, gateway_url, preferences_json, preview_key_json)
            VALUES (${recipientId}, ${session}, ${input.deviceId}, ${generation}, 'pending', ${fingerprint}, ${revocationHash}, ${input.topic}, ${input.environment}, ${url}, ${preferencesJson}, ${previewKeyJson})
          `;
        } else {
          yield* sql`
            UPDATE push_registrations SET session_id = ${session}, generation = ${generation}, status = ${same ? prior.status : "pending"},
              token_hash = ${fingerprint}, revocation_hash = ${revocationHash}, topic = ${input.topic}, environment = ${input.environment},
              gateway_url = ${url}, preferences_json = ${preferencesJson}, preview_key_json = ${previewKeyJson},
              foreground_until = CASE WHEN ${same} THEN foreground_until ELSE 0 END,
              foreground_thread_id = CASE WHEN ${same} THEN foreground_thread_id ELSE NULL END,
              acknowledged_sequence = CASE WHEN ${same} THEN acknowledged_sequence ELSE 0 END
            WHERE recipient_id = ${recipientId}
          `;
        }
        return yield* requireRegistration(session, input.deviceId, "register");
      }),
    );
    const receipt = yield* gateway
      .enroll(url, {
        recipientId: row.recipient_id,
        generation: row.generation,
        token: input.token,
        topic: input.topic,
        environment: input.environment,
        revocationToken: input.revocationToken,
      })
      .pipe(
        Effect.catchTags({
          PushGatewayRequestError: (cause) =>
            Effect.gen(function* () {
              if (cause.reason === "rejected") {
                yield* sql`UPDATE push_registrations SET status = 'revoked', foreground_until = 0 WHERE recipient_id = ${row.recipient_id} AND generation = ${row.generation}`;
              }
              return yield* new PushNotificationError({
                operation: "register",
                reason: cause.reason,
                cause,
              });
            }),
        }),
      );
    yield* sql`UPDATE push_registrations SET status = ${receipt.status} WHERE recipient_id = ${row.recipient_id} AND generation = ${row.generation} AND status <> 'revoked'`;
    return fromRow(yield* requireRegistration(session, input.deviceId, "register"));
  }, mapError("register"));

  const confirm = Effect.fn("PushNotifications.confirm")(function* (
    session: AuthSessionId,
    input: typeof PushConfirmInput.Type,
  ) {
    const row = yield* requireRegistration(session, input.deviceId, "confirm");
    if (
      row.recipient_id !== input.recipientId ||
      row.generation !== input.generation ||
      row.status === "revoked"
    )
      return yield* new PushNotificationError({ operation: "confirm", reason: "not-found" });
    yield* gateway
      .confirm(row.gateway_url, {
        recipientId: input.recipientId,
        generation: input.generation,
        challenge: input.challenge,
      })
      .pipe(gatewayError("confirm"));
    yield* sql`UPDATE push_registrations SET status = 'active' WHERE recipient_id = ${row.recipient_id} AND generation = ${row.generation} AND status = 'pending'`;
    return fromRow(yield* requireRegistration(session, input.deviceId, "confirm"));
  }, mapError("confirm"));

  const preferences = Effect.fn("PushNotifications.preferences")(function* (
    session: AuthSessionId,
    input: typeof PushPreferencesInput.Type,
  ) {
    const row = yield* requireRegistration(session, input.deviceId, "preferences");
    if (input.preferences.previews && row.preview_key_json === null)
      return yield* new PushNotificationError({ operation: "preferences", reason: "rejected" });
    const preferencesJson = yield* encodePreferences(input.preferences);
    yield* sql`UPDATE push_registrations SET preferences_json = ${preferencesJson} WHERE session_id = ${session} AND device_id = ${input.deviceId}`;
    return fromRow(yield* requireRegistration(session, input.deviceId, "preferences"));
  }, mapError("preferences"));

  const revoke = Effect.fn("PushNotifications.revoke")(function* (
    session: AuthSessionId,
    input: typeof PushRevokeInput.Type,
  ) {
    const row =
      input.revocationToken === undefined
        ? yield* read(session, input.deviceId)
        : yield* readBySecret(input.deviceId, yield* secretHash(input.revocationToken));
    if (
      row === undefined ||
      row.recipient_id !== input.recipientId ||
      (input.revocationToken === undefined
        ? row.generation !== input.generation
        : row.generation < input.generation)
    )
      return yield* new PushNotificationError({ operation: "revoke", reason: "not-found" });
    yield* sql`UPDATE push_registrations SET status = 'revoked', foreground_until = 0 WHERE recipient_id = ${row.recipient_id} AND generation = ${row.generation}`;
    yield* gateway
      .revoke(row.gateway_url, { recipientId: row.recipient_id, generation: row.generation })
      .pipe(gatewayError("revoke"));
  }, mapError("revoke"));

  const presence = Effect.fn("PushNotifications.presence")(function* (
    session: AuthSessionId,
    input: typeof PushPresenceInput.Type,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* sql`
      UPDATE push_registrations SET foreground_until = ${input.foreground ? now + 60_000 : 0}, foreground_thread_id = ${input.threadId}, acknowledged_sequence = ${input.sequence}
      WHERE session_id = ${session} AND device_id = ${input.deviceId} AND status = 'active'
    `;
  }, mapError("presence"));

  const resolve = Effect.fn("PushNotifications.resolve")(function* (
    session: AuthSessionId,
    input: typeof PushResolveInput.Type,
  ) {
    const rows = yield* sql<{
      thread_id: string;
      kind: (typeof PushResolvedNotification.Type)["kind"];
      event_sequence: number;
    }>`
      SELECT n.thread_id, n.kind, n.event_sequence FROM push_notifications n
      JOIN push_deliveries d ON d.notification_id = n.notification_id
      JOIN push_registrations r ON r.recipient_id = d.recipient_id
      WHERE n.notification_id = ${input.notificationId} AND d.recipient_id = ${input.recipientId}
        AND d.generation = ${input.generation} AND r.session_id = ${session} AND r.device_id = ${input.deviceId} AND r.status = 'active'
    `;
    const row = rows[0];
    if (
      row === undefined ||
      (yield* projections.getThreadShell(ThreadId.make(row.thread_id))) === null
    )
      return yield* new PushNotificationError({ operation: "resolve", reason: "not-found" });
    return { threadId: ThreadId.make(row.thread_id), kind: row.kind, sequence: row.event_sequence };
  }, mapError("resolve"));

  return PushNotifications.of({ state, register, confirm, preferences, revoke, presence, resolve });
});

export const layer = Layer.effect(PushNotifications, make);
