import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ThreadId,
} from "@supaterm/contracts";
import { PushNotificationError } from "@supaterm/contracts/push";
import { makeDrainableWorker } from "@supaterm/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PushAttention from "./PushAttention.ts";
import * as PushDeliveryWorker from "./PushDeliveryWorker.ts";
import * as PushRegistrations from "./PushRegistrations.ts";

const CURSOR_NAME = "push-candidates";
const PAGE_SIZE = 256;
const COMPLETION_FRESHNESS_MS = 10 * 60_000;
const REQUEST_ELIGIBILITY_MS = 24 * 60 * 60_000;

// Turn items and messages are the bulk of the event volume and never change attention.
const ATTENTION_EVENT_TYPES: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.provider-switched",
  "run.created",
  "run.updated",
  "run.background-work-cancelled",
  "run-attempt.created",
  "run-attempt.updated",
  "subagent.updated",
  "provider-session.detached",
  "provider-thread.updated",
  "runtime-request.updated",
]);

interface ThreadActivity {
  occurredAt: number;
  sequence: number;
  /** False when only server restart reconciliation touched the thread. */
  organic: boolean;
  /** Run and request ids the events carried, to recognize a thread's first occurrence. */
  readonly occurrenceIds: Set<string>;
}

const storageError = (cause: unknown) => new PushNotificationError({ reason: "storage", cause });

export class PushCandidateReactor extends Context.Service<
  PushCandidateReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Processes every stored event after the cursor. */
    readonly drain: Effect.Effect<void, PushNotificationError>;
  }
>()("supaterm/notifications/PushCandidateReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const eventStore = yield* EventStore.EventStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const attention = yield* PushAttention.PushAttention;
  const registrations = yield* PushRegistrations.PushRegistrations;
  const deliveries = yield* PushDeliveryWorker.PushDeliveryWorker;
  const lane = yield* Semaphore.make(1);

  // A first boot starts at the head so existing history never notifies.
  yield* Effect.gen(function* () {
    const latest = yield* eventStore.latestSequence();
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      )
      VALUES (${CURSOR_NAME}, 1, ${latest}, ${now})
      ON CONFLICT(projection_name) DO NOTHING
    `;
  }).pipe(Effect.mapError(storageError));

  const readCursor = sql<{ readonly last_sequence: number }>`
    SELECT last_sequence FROM orchestration_v2_projection_metadata
    WHERE projection_name = ${CURSOR_NAME}
  `.pipe(Effect.map((rows) => rows[0]?.last_sequence ?? 0));

  const collectActivity = (page: ReadonlyArray<OrchestrationV2StoredEvent>) => {
    const activity = new Map<ThreadId, ThreadActivity>();
    const pausedRequestIds = new Set<string>();
    for (const stored of page) {
      const event = stored.event;
      if (!ATTENTION_EVENT_TYPES.has(event.type)) continue;
      const entry = activity.get(event.threadId) ?? {
        occurredAt: 0,
        sequence: stored.sequence,
        organic: false,
        occurrenceIds: new Set<string>(),
      };
      entry.occurredAt = Math.max(entry.occurredAt, DateTime.toEpochMillis(event.occurredAt));
      entry.sequence = stored.sequence;
      entry.organic ||= !String(stored.commandId).startsWith("command:runtime-reconcile:");
      if (event.type === "run.created" || event.type === "run.updated") {
        entry.occurrenceIds.add(event.payload.id);
      }
      if (event.type === "runtime-request.updated") {
        entry.occurrenceIds.add(event.payload.id);
        if (event.payload.status === "pending" && event.payload.autoDismissPaused === true) {
          pausedRequestIds.add(event.payload.id);
        }
      }
      activity.set(event.threadId, entry);
    }
    return { activity, pausedRequestIds };
  };

  const mergeActivity = (into: ThreadActivity, from: ThreadActivity) => {
    into.occurredAt = Math.max(into.occurredAt, from.occurredAt);
    into.sequence = Math.max(into.sequence, from.sequence);
    into.organic ||= from.organic;
    for (const id of from.occurrenceIds) into.occurrenceIds.add(id);
  };

  const processPage = Effect.fn("PushCandidateReactor.processPage")(function* (
    page: ReadonlyArray<OrchestrationV2StoredEvent>,
  ) {
    const throughSequence = page.at(-1)?.sequence ?? 0;
    const { activity, pausedRequestIds } = collectActivity(page);

    const roots = new Map<
      ThreadId,
      { state: PushAttention.PushThreadAttentionState | null; activity: ThreadActivity }
    >();
    for (const [threadId, entry] of activity) {
      const state = yield* attention.forThread(threadId);
      const rootId = state?.thread.id ?? threadId;
      const existing = roots.get(rootId);
      if (existing === undefined) {
        roots.set(rootId, {
          state,
          activity: { ...entry, occurrenceIds: new Set(entry.occurrenceIds) },
        });
      } else {
        mergeActivity(existing.activity, entry);
      }
    }

    const priorRows =
      roots.size === 0
        ? []
        : yield* sql<{ readonly thread_id: string; readonly attention_key: string | null }>`
            SELECT thread_id, attention_key FROM push_thread_attention
            WHERE ${sql.in("thread_id", [...roots.keys()])}
          `;
    const prior = new Map(priorRows.map((row) => [row.thread_id, row.attention_key] as const));

    const enabled = yield* settings.getSettings.pipe(
      Effect.map((current) => current.pushNotificationsEnabled),
    );
    const recipients = enabled ? yield* registrations.listDeliverable : [];

    const writes: Array<Effect.Effect<unknown, SqlError.SqlError>> = [];
    let inserted = false;
    for (const [rootId, { state, activity: entry }] of roots) {
      const current = state?.attention ?? null;
      const known = prior.has(rootId);
      const previousKey = prior.get(rootId) ?? null;
      if (known && previousKey === (current?.key ?? null)) continue;
      if (!known && current === null && state !== null) {
        writes.push(sql`
          INSERT INTO push_thread_attention (thread_id, attention_key, kind, updated_sequence)
          VALUES (${rootId}, NULL, NULL, ${entry.sequence})
        `);
        continue;
      }
      writes.push(
        current === null
          ? sql`
              UPDATE push_deliveries SET status = 'cancelled', lease_until = NULL
              WHERE thread_id = ${rootId} AND status IN ('pending', 'leased')
            `
          : sql`
              UPDATE push_deliveries SET status = 'cancelled', lease_until = NULL
              WHERE thread_id = ${rootId} AND status IN ('pending', 'leased')
                AND attention_key <> ${current.key}
            `,
      );
      if (state === null || state.thread.deletedAt !== null) {
        writes.push(sql`DELETE FROM push_thread_attention WHERE thread_id = ${rootId}`);
        continue;
      }
      writes.push(sql`
        INSERT INTO push_thread_attention (thread_id, attention_key, kind, updated_sequence)
        VALUES (${rootId}, ${current?.key ?? null}, ${current?.kind ?? null}, ${entry.sequence})
        ON CONFLICT(thread_id) DO UPDATE SET
          attention_key = excluded.attention_key,
          kind = excluded.kind,
          updated_sequence = excluded.updated_sequence
      `);
      if (current === null || !entry.organic) continue;
      const occurrenceId = current.request?.requestId ?? state.thread.latestRunId;
      if (!known && (occurrenceId === null || !entry.occurrenceIds.has(occurrenceId))) continue;

      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const occurredAt = Math.min(entry.occurredAt, now);
      const isRequest = PushAttention.isRequestKind(current.kind);
      const deadline = isRequest ? yield* attention.requestDeadline(current) : null;
      const expiresAt = isRequest
        ? Math.min(deadline ?? Number.POSITIVE_INFINITY, occurredAt + REQUEST_ELIGIBILITY_MS)
        : occurredAt + COMPLETION_FRESHNESS_MS;
      if (expiresAt <= now) continue;
      const nextAttemptAt = isRequest
        ? occurredAt
        : occurredAt + PushDeliveryWorker.COMPLETION_GRACE_MS;
      for (const registration of recipients) {
        if (!registration.kinds[current.kind]) continue;
        const notificationId = yield* crypto.randomUUIDv4();
        inserted = true;
        writes.push(sql`
          INSERT INTO push_deliveries (
            registration_id, thread_id, attention_key, kind, occurred_at, expires_at,
            status, attempts, next_attempt_at, notification_id
          )
          VALUES (
            ${registration.registrationId}, ${rootId}, ${current.key}, ${current.kind},
            ${occurredAt}, ${expiresAt}, 'pending', 0, ${nextAttemptAt}, ${notificationId}
          )
          ON CONFLICT(registration_id, thread_id, attention_key) DO NOTHING
        `);
      }
    }
    // Pausing a question's auto-dismiss shows the user saw it.
    for (const requestId of pausedRequestIds) {
      writes.push(sql`
        UPDATE push_deliveries SET status = 'cancelled', lease_until = NULL
        WHERE status IN ('pending', 'leased')
          AND substr(attention_key, -${requestId.length + 1}) = ${`:${requestId}`}
      `);
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const write of writes) yield* write;
        yield* sql`
          UPDATE orchestration_v2_projection_metadata
          SET last_sequence = ${throughSequence}, updated_at = ${now}
          WHERE projection_name = ${CURSOR_NAME}
        `;
      }),
    );
    if (inserted) yield* deliveries.wake;
  }, Effect.mapError(storageError));

  const drain: PushCandidateReactor["Service"]["drain"] = lane.withPermit(
    Effect.gen(function* () {
      for (;;) {
        const cursor = yield* readCursor.pipe(Effect.mapError(storageError));
        const page = yield* eventStore
          .read({ afterSequence: cursor, limit: PAGE_SIZE })
          .pipe(Stream.runCollect, Effect.mapError(storageError));
        if (page.length === 0) return;
        yield* processPage(page);
        if (page.length < PAGE_SIZE) return;
      }
    }),
  );

  const start: PushCandidateReactor["Service"]["start"] = Effect.fn("PushCandidateReactor.start")(
    function* () {
      const scheduled = yield* Ref.make(false);
      const worker = yield* makeDrainableWorker(() =>
        Ref.set(scheduled, false).pipe(Effect.andThen(drain)),
      );
      const schedule = Ref.getAndSet(scheduled, true).pipe(
        Effect.flatMap((already) => (already ? Effect.void : worker.enqueue(undefined))),
      );
      yield* schedule;
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          ATTENTION_EVENT_TYPES.has(event.type) ? schedule : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("push candidate event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return PushCandidateReactor.of({ start, drain });
});

export const layer = Layer.effect(PushCandidateReactor, make);
