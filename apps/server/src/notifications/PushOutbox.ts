import { ThreadId, type OrchestrationV2StoredEvent } from "@supaterm/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  PushNotificationError,
  PushPreferences,
  type PushNotificationKind,
  PushDeliveryPayload,
  PushPreviewContent,
} from "@supaterm/contracts/push";
import {
  eventChangesNotificationAttention,
  threadNotificationAttention,
} from "@supaterm/shared/threadNotificationAttention";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { pushPreviewContent } from "./pushPreviewContent.ts";

const decodePreferences = Schema.decodeUnknownSync(Schema.fromJsonString(PushPreferences));
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(PushDeliveryPayload));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(PushDeliveryPayload));
const encodeContent = Schema.encodeEffect(Schema.fromJsonString(PushPreviewContent));

export interface PendingPushDelivery {
  readonly notification_id: string;
  readonly recipient_id: string;
  readonly generation: number;
  readonly attempts: number;
  readonly thread_id: string;
  readonly attention_key: string;
  readonly kind: PushNotificationKind;
  readonly event_sequence: number;
  readonly created_at: number;
  readonly expires_at: number;
  readonly gateway_url: string;
  readonly preview_json: string | null;
  readonly preview_key_json: string | null;
  readonly preferences_json: string;
  readonly payload_json: string | null;
}

export class PushOutbox extends Context.Service<
  PushOutbox,
  {
    readonly record: (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
    ) => Effect.Effect<void, PushNotificationError>;
    readonly wake: Effect.Effect<void>;
    readonly awaitAvailable: Effect.Effect<void>;
    readonly nextDelay: Effect.Effect<number, PushNotificationError>;
    readonly claim: Effect.Effect<PendingPushDelivery | null, PushNotificationError>;
    readonly eligible: (
      delivery: PendingPushDelivery,
    ) => Effect.Effect<boolean, PushNotificationError>;
    readonly settle: (
      delivery: PendingPushDelivery,
      status: "accepted" | "failed" | "cancelled" | "retry",
    ) => Effect.Effect<void, PushNotificationError>;
    readonly prepare: (
      delivery: PendingPushDelivery,
      payload: PushDeliveryPayload,
    ) => Effect.Effect<string | null, PushNotificationError>;
  }
>()("supaterm/notifications/PushOutbox") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;
  const available = yield* Queue.dropping<void>(1);
  const storageError = (cause: unknown) =>
    new PushNotificationError({ operation: "deliver", reason: "storage", cause });
  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const record = Effect.fn("PushOutbox.record")(function* (
    events: ReadonlyArray<OrchestrationV2StoredEvent>,
  ) {
    const changed = new Map<ThreadId, number>();
    for (const stored of events) {
      if (eventChangesNotificationAttention(stored.event))
        changed.set(stored.event.threadId, stored.sequence);
    }
    if (changed.size === 0) return;
    const now = yield* nowMillis;
    for (const [threadId, sequence] of changed) {
      const thread = yield* projections.getThreadShell(threadId);
      const attention = thread === null ? null : threadNotificationAttention(thread);
      const prior = yield* sql<{
        attention_key: string | null;
      }>`SELECT attention_key FROM push_thread_attention WHERE thread_id = ${threadId}`;
      if (prior[0]?.attention_key === (attention?.key ?? null)) continue;
      yield* sql`
        INSERT INTO push_thread_attention(thread_id, attention_key) VALUES (${threadId}, ${attention?.key ?? null})
        ON CONFLICT(thread_id) DO UPDATE SET attention_key = excluded.attention_key
      `;
      if (attention === null) continue;
      const registrations = yield* sql<{
        recipient_id: string;
        generation: number;
        preferences_json: string;
        foreground_until: number;
        foreground_thread_id: string | null;
      }>`
        SELECT r.recipient_id, r.generation, r.preferences_json, r.foreground_until, r.foreground_thread_id
        FROM push_registrations r JOIN auth_sessions s ON s.session_id = r.session_id
        WHERE r.status = 'active' AND s.revoked_at IS NULL AND s.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
      `;
      const eligible = registrations.filter((row) => {
        const preferences = decodePreferences(row.preferences_json);
        return preferences.enabled && preferences[attention.kind];
      });
      if (eligible.length === 0) continue;
      const id = yield* crypto.randomUUIDv4;
      const previewJson =
        thread !== null && eligible.some((row) => decodePreferences(row.preferences_json).previews)
          ? yield* encodeContent(pushPreviewContent(thread, attention.kind))
          : null;
      const inserted = yield* sql<{ notification_id: string }>`
        INSERT INTO push_notifications(notification_id, thread_id, attention_key, kind, event_sequence, created_at, expires_at, preview_json)
        VALUES (${id}, ${threadId}, ${attention.key}, ${attention.kind}, ${sequence}, ${now}, ${now + 86_400_000}, ${previewJson})
        ON CONFLICT(thread_id, attention_key) DO NOTHING RETURNING notification_id
      `;
      if (inserted.length === 0) continue;
      for (const registration of eligible) {
        const delay =
          registration.foreground_until > now && registration.foreground_thread_id === threadId
            ? 2_000
            : 0;
        yield* sql`
          INSERT INTO push_deliveries(notification_id, recipient_id, generation, available_at)
          VALUES (${id}, ${registration.recipient_id}, ${registration.generation}, ${now + delay})
        `;
      }
    }
  }, Effect.mapError(storageError));

  const claim = sql
    .withTransaction(
      Effect.gen(function* () {
        const now = yield* nowMillis;
        yield* sql`DELETE FROM push_notifications WHERE expires_at < ${now - 86_400_000}`;
        const claimed = yield* sql<{
          notification_id: string;
          recipient_id: string;
          generation: number;
        }>`
      UPDATE push_deliveries SET status = 'running', attempts = attempts + 1, lease_until = ${now + 30_000}
      WHERE (notification_id, recipient_id, generation) = (
        SELECT notification_id, recipient_id, generation FROM push_deliveries
        WHERE (status = 'pending' AND available_at <= ${now}) OR (status = 'running' AND lease_until <= ${now})
        ORDER BY available_at LIMIT 1
      ) RETURNING notification_id, recipient_id, generation
    `;
        const row = claimed[0];
        if (row === undefined) return null;
        const deliveries = yield* sql<PendingPushDelivery>`
      SELECT d.notification_id, d.recipient_id, d.generation, d.attempts,
             n.thread_id, n.attention_key, n.kind, n.event_sequence, n.created_at, n.expires_at, r.gateway_url,
             n.preview_json, r.preview_key_json, r.preferences_json, d.payload_json
      FROM push_deliveries d JOIN push_notifications n ON n.notification_id = d.notification_id
      JOIN push_registrations r ON r.recipient_id = d.recipient_id
      WHERE d.notification_id = ${row.notification_id} AND d.recipient_id = ${row.recipient_id} AND d.generation = ${row.generation}
    `;
        return deliveries[0] ?? null;
      }),
    )
    .pipe(Effect.mapError(storageError));

  const eligible = Effect.fn("PushOutbox.eligible")(function* (delivery: PendingPushDelivery) {
    const now = yield* nowMillis;
    if (delivery.expires_at <= now) return false;
    const rows = yield* sql<{
      preferences_json: string;
      foreground_until: number;
      foreground_thread_id: string | null;
      acknowledged_sequence: number;
    }>`
      SELECT r.preferences_json, r.foreground_until, r.foreground_thread_id, r.acknowledged_sequence
      FROM push_registrations r JOIN auth_sessions s ON s.session_id = r.session_id
      WHERE r.recipient_id = ${delivery.recipient_id} AND r.generation = ${delivery.generation} AND r.status = 'active'
        AND s.revoked_at IS NULL AND s.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(now))}
    `;
    const row = rows[0];
    if (row === undefined) return false;
    const preferences = decodePreferences(row.preferences_json);
    if (!preferences.enabled || !preferences[delivery.kind]) return false;
    if (
      delivery.payload_json !== null &&
      !preferences.previews &&
      decodePayload(delivery.payload_json).preview !== undefined
    )
      return false;
    if (
      row.foreground_until > now &&
      row.foreground_thread_id === delivery.thread_id &&
      row.acknowledged_sequence >= delivery.event_sequence
    )
      return false;
    const thread = yield* projections.getThreadShell(ThreadId.make(delivery.thread_id));
    return thread !== null && threadNotificationAttention(thread)?.key === delivery.attention_key;
  }, Effect.mapError(storageError));

  const settle = Effect.fn("PushOutbox.settle")(function* (
    delivery: PendingPushDelivery,
    status: "accepted" | "failed" | "cancelled" | "retry",
  ) {
    const now = yield* nowMillis;
    const retry = status === "retry" && delivery.expires_at > now;
    const next = now + Math.min(300_000, 1_000 * 2 ** Math.min(delivery.attempts, 9));
    yield* sql`
      UPDATE push_deliveries SET status = ${retry ? "pending" : status === "retry" ? "failed" : status}, available_at = ${next}, lease_until = 0
      WHERE notification_id = ${delivery.notification_id} AND recipient_id = ${delivery.recipient_id}
        AND generation = ${delivery.generation} AND status = 'running' AND attempts = ${delivery.attempts}
    `;
  }, Effect.mapError(storageError));

  const nextDelay = Effect.gen(function* () {
    const now = yield* nowMillis;
    const rows = yield* sql<{
      next: number | null;
    }>`SELECT MIN(CASE WHEN status = 'running' THEN lease_until ELSE available_at END) AS next FROM push_deliveries WHERE status IN ('pending', 'running')`;
    return Math.max(1, Math.min(30_000, (rows[0]?.next ?? now + 30_000) - now));
  }).pipe(Effect.mapError(storageError));
  const prepare = Effect.fn("PushOutbox.prepare")(function* (
    delivery: PendingPushDelivery,
    payload: PushDeliveryPayload,
  ) {
    const encoded = yield* encodePayload(payload);
    const rows = yield* sql<{ payload_json: string }>`
      UPDATE push_deliveries SET payload_json = COALESCE(payload_json, ${encoded})
      WHERE notification_id = ${delivery.notification_id} AND recipient_id = ${delivery.recipient_id}
        AND generation = ${delivery.generation} AND status = 'running' AND attempts = ${delivery.attempts}
      RETURNING payload_json
    `;
    return rows[0]?.payload_json ?? null;
  }, Effect.mapError(storageError));
  return PushOutbox.of({
    record,
    claim,
    eligible,
    settle,
    nextDelay,
    prepare,
    wake: Queue.offer(available, undefined).pipe(Effect.asVoid),
    awaitAvailable: Queue.take(available),
  });
});

export const layer = Layer.effect(PushOutbox, make).pipe(Layer.provide(NodeCrypto.layer));
