import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE push_registrations (
      recipient_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES auth_sessions(session_id),
      device_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      revocation_hash TEXT NOT NULL,
      topic TEXT NOT NULL,
      environment TEXT NOT NULL,
      gateway_url TEXT NOT NULL,
      preferences_json TEXT NOT NULL,
      foreground_until INTEGER NOT NULL DEFAULT 0,
      foreground_thread_id TEXT,
      acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, device_id),
      UNIQUE(device_id, revocation_hash)
    )
  `;
  yield* sql`
    CREATE TABLE push_thread_attention (
      thread_id TEXT PRIMARY KEY,
      attention_key TEXT
    )
  `;
  yield* sql`
    CREATE TABLE push_notifications (
      notification_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      attention_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE(thread_id, attention_key)
    )
  `;
  yield* sql`
    CREATE TABLE push_deliveries (
      notification_id TEXT NOT NULL REFERENCES push_notifications(notification_id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES push_registrations(recipient_id),
      generation INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(notification_id, recipient_id, generation)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX push_deliveries_available ON push_deliveries(status, available_at)`;
  yield* sql`CREATE INDEX push_notifications_expiry ON push_notifications(expires_at)`;
});
