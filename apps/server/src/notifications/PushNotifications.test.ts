import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthSessionId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@supacode/contracts";
import {
  DEFAULT_PUSH_PREFERENCES,
  PushNotificationError,
  type PushDeliveryPayload,
} from "@supacode/contracts/push";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as PushGateway from "./PushGateway.ts";
import * as PushNotifications from "./PushNotifications.ts";
import * as PushOutbox from "./PushOutbox.ts";
import * as PushDeliveryWorker from "./PushDeliveryWorker.ts";
import * as PushPreview from "./PushPreview.ts";

const session = AuthSessionId.make("push-session");
const otherSession = AuthSessionId.make("other-session");
const deviceId = "3369f9f0-77a8-46db-8ab5-c36f3d689563";
const threadId = ThreadId.make("push-thread");
const preferences = { ...DEFAULT_PUSH_PREFERENCES, enabled: true };
const registerInput = {
  deviceId,
  token: "ab".repeat(32),
  topic: "com.supaterm.supacode",
  environment: "sandbox" as const,
  revocationToken: "a".repeat(43),
  preferences,
};
const fakeGateway = PushGateway.PushGateway.of({
  enroll: () => Effect.succeed({ status: "pending" }),
  confirm: () => Effect.void,
  revoke: () => Effect.void,
  send: () => Effect.succeed({ accepted: true, retryable: false, invalidToken: false }),
});
const fakePreview = PushPreview.PushPreview.of({
  hostSigningKey: Effect.succeed("a".repeat(43)),
  encrypt: () =>
    Effect.succeed({
      version: 1,
      keyId: deviceId,
      enc: "a".repeat(43),
      ciphertext: "b".repeat(22),
      signature: "c".repeat(86),
    }),
});
function testLayer(gateway = fakeGateway, preview = fakePreview) {
  const persistence = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
    Layer.provideMerge(Sqlite.layerMemory),
  );
  const services = Layer.mergeAll(PushOutbox.layer, PushNotifications.layer, EventSink.layer).pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(Layer.succeed(PushGateway.PushGateway, gateway)),
    Layer.provideMerge(Layer.succeed(PushPreview.PushPreview, preview)),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(NodeCrypto.layer),
  );
  return PushDeliveryWorker.layer.pipe(
    Layer.provideMerge(services),
    Layer.provide(Layer.succeed(ServerActivation, Effect.never)),
  );
}
const seedSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of [session, otherSession])
    yield* sql`INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at) VALUES (${id},'device','[]','pairing','1970-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')`;
});
const createThread = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const providerInstanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
  const runId = RunId.make("push-run");
  yield* sink.write({
    events: [
      {
        id: EventId.make("push-thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("push-project"),
          title: "Notification fixture",
          createdBy: "user",
          creationSource: "mobile",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
    ],
  });
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("push-message"),
    rootNodeId: NodeId.make("push-node"),
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make("push-run-created"),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: run,
      },
    ],
  });
  const completed = {
    id: EventId.make("push-run-completed"),
    type: "run.updated",
    threadId,
    runId,
    occurredAt: now,
    payload: { ...run, status: "completed" as const, completedAt: now },
  } satisfies OrchestrationV2DomainEvent;
  return { sink, run, completed, now };
});
const activate = Effect.gen(function* () {
  const push = yield* PushNotifications.PushNotifications;
  const registration = yield* push.register(session, registerInput);
  yield* push.confirm(session, {
    deviceId,
    recipientId: registration.recipientId,
    generation: registration.generation,
    challenge: "b".repeat(43),
  });
  return registration;
});
const activatePreview = Effect.gen(function* () {
  const push = yield* PushNotifications.PushNotifications;
  const registration = yield* push.register(session, {
    ...registerInput,
    preferences: { ...preferences, previews: true },
    previewKey: { keyId: deviceId, publicKey: "a".repeat(43) },
  });
  yield* push.confirm(session, {
    deviceId,
    recipientId: registration.recipientId,
    generation: registration.generation,
    challenge: "b".repeat(43),
  });
  return registration;
});

it.effect("persists one opaque preview payload across ambiguous delivery retries", () => {
  const sent: PushDeliveryPayload[] = [];
  let encrypted = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      yield* activatePreview;
      const { sink, completed } = yield* createThread;
      yield* sink.write({ events: [completed] });
      const worker = yield* PushDeliveryWorker.PushDeliveryWorker;
      yield* worker.drain;
      yield* TestClock.adjust("3 seconds");
      yield* worker.drain;
      assert.strictEqual(encrypted, 1);
      assert.strictEqual(sent.length, 2);
      assert.deepStrictEqual(sent[0], sent[1]);
      assert.isDefined(sent[0]?.preview);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        payload_json: string;
        status: string;
      }>`SELECT payload_json, status FROM push_deliveries`;
      assert.strictEqual(rows[0]?.status, "accepted");
      assert.strictEqual(rows[0]?.payload_json.includes("Notification fixture"), false);
    }).pipe(
      Effect.provide(
        testLayer(
          {
            ...fakeGateway,
            send: (payloadUrl, payload) =>
              Effect.sync(() => {
                sent.push(payload);
                return {
                  accepted: sent.length > 1,
                  retryable: sent.length === 1,
                  invalidToken: false,
                };
              }),
          },
          {
            ...fakePreview,
            encrypt: (key, metadata, content) =>
              Effect.sync(() => {
                encrypted++;
                assert.strictEqual(content.title, "Notification fixture");
                return {
                  version: 1,
                  keyId: key.keyId,
                  enc: "a".repeat(43),
                  ciphertext: Buffer.alloc(16, encrypted).toString("base64url"),
                  signature: "c".repeat(86),
                };
              }),
          },
        ),
      ),
    ),
  );
});

it.effect("falls back to the generic alert when preview encryption cannot complete", () => {
  const sent: PushDeliveryPayload[] = [];
  return Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      yield* activatePreview;
      const { sink, completed } = yield* createThread;
      yield* sink.write({ events: [completed] });
      yield* (yield* PushDeliveryWorker.PushDeliveryWorker).drain;
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0]?.preview, undefined);
    }).pipe(
      Effect.provide(
        testLayer(
          {
            ...fakeGateway,
            send: (url, payload) =>
              Effect.sync(() => {
                sent.push(payload);
                return { accepted: true, retryable: false, invalidToken: false };
              }),
          },
          {
            ...fakePreview,
            encrypt: () =>
              Effect.fail(new PushNotificationError({ operation: "deliver", reason: "storage" })),
          },
        ),
      ),
    ),
  );
});

it.effect("cancels a prepared encrypted retry after previews are disabled", () => {
  let sends = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      yield* activatePreview;
      const { sink, completed } = yield* createThread;
      yield* sink.write({ events: [completed] });
      const worker = yield* PushDeliveryWorker.PushDeliveryWorker;
      yield* worker.drain;
      yield* (yield* PushNotifications.PushNotifications).preferences(session, {
        deviceId,
        preferences,
      });
      yield* TestClock.adjust("3 seconds");
      yield* worker.drain;
      assert.strictEqual(sends, 1);
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ status: string }>`SELECT status FROM push_deliveries`)[0]?.status,
        "cancelled",
      );
    }).pipe(
      Effect.provide(
        testLayer({
          ...fakeGateway,
          send: () =>
            Effect.sync(() => {
              sends++;
              return { accepted: false, retryable: true, invalidToken: false };
            }),
        }),
      ),
    ),
  );
});

it.effect("fans a committed event out to two eligible devices without duplicate attention", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      yield* activate;
      const push = yield* PushNotifications.PushNotifications;
      const second = yield* push.register(otherSession, {
        ...registerInput,
        deviceId: "8abc64c5-68b4-44db-98d1-9155187e5c1b",
      });
      yield* push.confirm(otherSession, {
        deviceId: "8abc64c5-68b4-44db-98d1-9155187e5c1b",
        recipientId: second.recipientId,
        generation: 1,
        challenge: "b".repeat(43),
      });
      const { sink, completed } = yield* createThread;
      const stored = yield* sink.write({ events: [completed] });
      const sql = yield* SqlClient.SqlClient;
      const notifications = yield* sql<{
        event_sequence: number;
      }>`SELECT event_sequence FROM push_notifications`;
      assert.strictEqual(notifications.length, 1);
      assert.strictEqual(notifications[0]?.event_sequence, stored[0]?.sequence);
      assert.strictEqual((yield* sql`SELECT * FROM push_deliveries`).length, 2);
      yield* sink.write({
        events: [{ ...completed, id: EventId.make("push-run-completed-again") }],
      });
      assert.strictEqual((yield* sql`SELECT * FROM push_notifications`).length, 1);
      assert.strictEqual((yield* sql`SELECT * FROM push_deliveries`).length, 2);
    }).pipe(Effect.provide(testLayer())),
  ),
);

it.effect("rolls back events and projections when notification enqueue fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      yield* activate;
      const { sink, completed } = yield* createThread;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER reject_push BEFORE INSERT ON push_notifications BEGIN SELECT RAISE(ABORT,'reject'); END`;
      const before = yield* (yield* EventStore.EventStoreV2).latestSequence();
      const result = yield* Effect.result(sink.write({ events: [completed] }));
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(yield* (yield* EventStore.EventStoreV2).latestSequence(), before);
      const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(threadId);
      assert.strictEqual(shell?.status, "running");
      assert.strictEqual((yield* sql`SELECT * FROM push_deliveries`).length, 0);
    }).pipe(Effect.provide(testLayer())),
  ),
);

it.effect("reclassifies completion when the final background item ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      yield* activate;
      const { sink, completed, run, now } = yield* createThread;
      const sql = yield* SqlClient.SqlClient;
      const item = {
        id: TurnItemId.make("push-monitor"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running" as const,
        title: "Monitor",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "dynamic_tool" as const,
        toolName: "watch",
        input: "",
        output: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("push-monitor-start"),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: item,
          },
          completed,
        ],
      });
      assert.strictEqual((yield* sql`SELECT * FROM push_notifications`).length, 0);
      yield* sink.write({
        events: [
          {
            id: EventId.make("push-monitor-end"),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...item, status: "completed", completedAt: now },
          },
        ],
      });
      assert.strictEqual((yield* sql`SELECT * FROM push_notifications`).length, 1);
    }).pipe(Effect.provide(testLayer())),
  ),
);

it.effect(
  "fences lease recovery and rechecks generation, preference, expiry, and acknowledged presence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedSessions;
        const registration = yield* activate;
        const { sink, completed } = yield* createThread;
        yield* sink.write({ events: [completed] });
        const outbox = yield* PushOutbox.PushOutbox;
        const push = yield* PushNotifications.PushNotifications;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* outbox.claim;
        assert.isNotNull(first);
        if (first === null) return;
        assert.strictEqual(yield* outbox.eligible(first), true);
        yield* TestClock.adjust("31 seconds");
        const second = yield* outbox.claim;
        assert.isNotNull(second);
        if (second === null) return;
        yield* outbox.settle(first, "accepted");
        assert.strictEqual(
          (yield* sql<{ status: string }>`SELECT status FROM push_deliveries`)[0]?.status,
          "running",
        );
        yield* push.presence(session, {
          deviceId,
          foreground: true,
          threadId,
          sequence: first.event_sequence - 1,
        });
        assert.strictEqual(yield* outbox.eligible(second), true);
        yield* push.presence(session, {
          deviceId,
          foreground: true,
          threadId,
          sequence: first.event_sequence,
        });
        assert.strictEqual(yield* outbox.eligible(second), false);
        yield* TestClock.adjust("61 seconds");
        assert.strictEqual(yield* outbox.eligible(second), true);
        yield* push.preferences(session, {
          deviceId,
          preferences: { ...preferences, completion: false },
        });
        assert.strictEqual(yield* outbox.eligible(second), false);
        yield* push.preferences(session, { deviceId, preferences });
        yield* sql`UPDATE push_registrations SET generation = ${registration.generation + 1}`;
        assert.strictEqual(yield* outbox.eligible(second), false);
        yield* sql`UPDATE push_registrations SET generation = ${registration.generation}`;
        yield* TestClock.adjust("25 hours");
        assert.strictEqual(yield* outbox.eligible(second), false);
      }).pipe(Effect.provide(testLayer())),
    ),
);

it.effect("keeps registrations session-scoped and refuses stale revocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      const push = yield* PushNotifications.PushNotifications;
      const first = yield* activate;
      assert.isNull((yield* push.state(otherSession, deviceId)).registration);
      const wrong = yield* Effect.result(
        push.confirm(otherSession, {
          deviceId,
          recipientId: first.recipientId,
          generation: 1,
          challenge: "b".repeat(43),
        }),
      );
      assert.strictEqual(wrong._tag, "Failure");
      const second = yield* push.register(session, { ...registerInput, token: "cd".repeat(32) });
      assert.strictEqual(second.generation, 2);
      const stale = yield* Effect.result(
        push.revoke(session, { deviceId, recipientId: first.recipientId, generation: 1 }),
      );
      assert.strictEqual(stale._tag, "Failure");
      assert.strictEqual((yield* push.state(session, deviceId)).registration?.status, "pending");
    }).pipe(Effect.provide(testLayer())),
  ),
);

it.effect(
  "retries durable deliveries without blocking orchestration and expires abandoned work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedSessions;
        yield* activate;
        const { sink, completed } = yield* createThread;
        yield* sink.write({ events: [completed] });
        const worker = yield* PushDeliveryWorker.PushDeliveryWorker;
        const sql = yield* SqlClient.SqlClient;
        yield* worker.drain;
        assert.strictEqual(
          (yield* sql<{ status: string }>`SELECT status FROM push_deliveries`)[0]?.status,
          "pending",
        );
        yield* TestClock.adjust("25 hours");
        yield* worker.drain;
        assert.strictEqual(
          (yield* sql<{ status: string }>`SELECT status FROM push_deliveries`)[0]?.status,
          "cancelled",
        );
      }).pipe(
        Effect.provide(
          testLayer({
            ...fakeGateway,
            send: () => Effect.succeed({ accepted: false, retryable: true, invalidToken: false }),
          }),
        ),
      ),
    ),
);

it.effect("resolves only a delivery owned by the requesting session and device", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      const registration = yield* activate;
      const { sink, completed } = yield* createThread;
      const stored = yield* sink.write({ events: [completed] });
      const sql = yield* SqlClient.SqlClient;
      const row = (yield* sql<{
        notification_id: string;
      }>`SELECT notification_id FROM push_notifications`)[0];
      assert.isDefined(row);
      if (row === undefined) return;
      const push = yield* PushNotifications.PushNotifications;
      const input = {
        deviceId,
        recipientId: registration.recipientId,
        generation: registration.generation,
        notificationId: row.notification_id,
      };
      const resolved = yield* push.resolve(session, input);
      assert.strictEqual(resolved.threadId, threadId);
      assert.strictEqual(resolved.sequence, stored[0]?.sequence);
      const wrong = yield* Effect.result(push.resolve(otherSession, input));
      assert.strictEqual(wrong._tag, "Failure");
      const badId = yield* Effect.result(
        push.resolve(session, { ...input, notificationId: "a33bc794-cd24-4a2a-90a7-b6b28f97569c" }),
      );
      assert.strictEqual(badId._tag, "Failure");
    }).pipe(Effect.provide(testLayer())),
  ),
);

it.effect(
  "returns to pending ownership verification if the gateway lost an active registration",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedSessions;
        yield* activate;
        const push = yield* PushNotifications.PushNotifications;
        const registered = yield* push.register(session, registerInput);
        assert.strictEqual(registered.status, "pending");
      }).pipe(Effect.provide(testLayer())),
    ),
);

it.effect("recovers a gateway-revoked registration by advancing its generation", () => {
  let rejected = false;
  const gateway = {
    ...fakeGateway,
    enroll: () =>
      rejected
        ? Effect.fail(new PushGateway.PushGatewayRequestError({ reason: "rejected" }))
        : Effect.succeed({ status: "pending" as const }),
  };
  return Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      yield* activate;
      const push = yield* PushNotifications.PushNotifications;
      rejected = true;
      const result = yield* Effect.result(push.register(session, registerInput));
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual((yield* push.state(session, deviceId)).registration?.status, "revoked");
      rejected = false;
      const renewed = yield* push.register(session, registerInput);
      assert.strictEqual(renewed.generation, 2);
      assert.strictEqual(renewed.status, "pending");
    }).pipe(Effect.provide(testLayer(gateway))),
  );
});

it.effect("transfers one recipient after re-pairing and fences the previous session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      const first = yield* activate;
      const push = yield* PushNotifications.PushNotifications;
      yield* push.presence(session, { deviceId, foreground: true, threadId, sequence: 10 });
      const transferred = yield* push.register(otherSession, registerInput);
      assert.strictEqual(transferred.recipientId, first.recipientId);
      assert.strictEqual(transferred.generation, 2);
      assert.strictEqual((yield* push.state(session, deviceId)).registration, null);
      assert.strictEqual(
        (yield* Effect.result(push.preferences(session, { deviceId, preferences })))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Effect.result(
          push.revoke(session, {
            deviceId,
            recipientId: first.recipientId,
            generation: first.generation,
          }),
        ))._tag,
        "Failure",
      );
      yield* push.confirm(otherSession, {
        deviceId,
        recipientId: transferred.recipientId,
        generation: transferred.generation,
        challenge: "b".repeat(43),
      });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        foreground_until: number;
        acknowledged_sequence: number;
      }>`SELECT * FROM push_registrations`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.foreground_until, 0);
      assert.strictEqual(rows[0]?.acknowledged_sequence, 0);
      const { sink, completed } = yield* createThread;
      yield* sink.write({ events: [completed] });
      assert.strictEqual((yield* sql`SELECT * FROM push_deliveries`).length, 1);
    }).pipe(Effect.provide(testLayer())),
  ),
);

it.effect(
  "requires the device secret to claim a recipient across sessions and token rotation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedSessions;
        const first = yield* activate;
        const push = yield* PushNotifications.PushNotifications;
        const wrong = yield* Effect.result(
          push.revoke(otherSession, {
            deviceId,
            recipientId: first.recipientId,
            generation: first.generation,
            revocationToken: "z".repeat(43),
          }),
        );
        assert.strictEqual(wrong._tag, "Failure");
        const rotated = yield* push.register(otherSession, {
          ...registerInput,
          token: "cd".repeat(32),
        });
        assert.strictEqual(rotated.recipientId, first.recipientId);
        assert.strictEqual(rotated.generation, 2);
        assert.strictEqual((yield* push.state(session, deviceId)).registration, null);
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* sql`SELECT * FROM push_registrations`).length, 1);
      }).pipe(Effect.provide(testLayer())),
    ),
);

it.effect(
  "reconciles revocation after re-pairing and preserves ownership through secret rotation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedSessions;
        const first = yield* activate;
        const push = yield* PushNotifications.PushNotifications;
        const revokeInput = {
          deviceId,
          recipientId: first.recipientId,
          generation: first.generation,
          revocationToken: registerInput.revocationToken,
        };
        yield* push.revoke(otherSession, revokeInput);
        assert.strictEqual((yield* push.state(session, deviceId)).registration?.status, "revoked");
        const renewalInput = {
          ...registerInput,
          revocationToken: "c".repeat(43),
          previousRevocationToken: registerInput.revocationToken,
        };
        const renewed = yield* push.register(otherSession, renewalInput);
        assert.strictEqual(renewed.recipientId, first.recipientId);
        assert.strictEqual(renewed.generation, 2);
        assert.strictEqual((yield* push.register(otherSession, renewalInput)).generation, 2);
        assert.strictEqual(
          (yield* Effect.result(push.revoke(otherSession, revokeInput)))._tag,
          "Failure",
        );
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* sql`SELECT * FROM push_registrations`).length, 1);
      }).pipe(Effect.provide(testLayer())),
    ),
);

it.effect("does not claim another session's registration using a device ID alone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedSessions;
      const first = yield* activate;
      const push = yield* PushNotifications.PushNotifications;
      const separate = yield* push.register(otherSession, {
        ...registerInput,
        revocationToken: "z".repeat(43),
      });
      assert.notStrictEqual(separate.recipientId, first.recipientId);
      assert.strictEqual(
        (yield* push.state(session, deviceId)).registration?.recipientId,
        first.recipientId,
      );
    }).pipe(Effect.provide(testLayer())),
  ),
);
