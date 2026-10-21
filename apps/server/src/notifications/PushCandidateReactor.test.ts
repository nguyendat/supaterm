import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@supaterm/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as PushCandidateReactor from "./PushCandidateReactor.ts";
import * as PushNotifications from "./PushNotifications.ts";
import {
  insertSession,
  layerPushServices,
  type PushWorld,
  recipientKeyPair,
  registerInput,
  threadShell,
  withPushWorld,
} from "./testkit/pushWorld.ts";

const SESSION = AuthSessionId.make("session-a");
const REGISTRATION_ID = "6f1c2b9e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";
const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("child");

const deliveries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly thread_id: string;
    readonly attention_key: string;
    readonly kind: string;
    readonly status: string;
    readonly occurred_at: number;
    readonly expires_at: number;
    readonly next_attempt_at: number;
  }>`
    SELECT thread_id, attention_key, kind, status, occurred_at, expires_at, next_attempt_at
    FROM push_deliveries ORDER BY delivery_id
  `;
});

const cursor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly last_sequence: number }>`
    SELECT last_sequence FROM orchestration_v2_projection_metadata
    WHERE projection_name = 'push-candidates'
  `;
  return rows[0]?.last_sequence;
});

const register = Effect.gen(function* () {
  yield* insertSession(SESSION);
  const { publicKey } = yield* recipientKeyPair;
  yield* (yield* PushNotifications.PushNotifications).register(
    SESSION,
    registerInput(REGISTRATION_ID, publicKey),
  );
});

const drain = Effect.flatMap(PushCandidateReactor.PushCandidateReactor, (reactor) => reactor.drain);

const runEvent = (world: PushWorld, threadId: string, runId: string, status: string) =>
  Effect.flatMap(DateTime.now, (occurredAt) =>
    world.appendEvent({
      type: "run.updated",
      threadId,
      occurredAt,
      payload: { id: RunId.make(runId), status },
    }),
  );

function subagentRecord(childThreadId: ThreadId): OrchestrationV2Subagent {
  return {
    childThreadId,
    origin: "app_owned",
    status: "running",
  } as unknown as OrchestrationV2Subagent;
}

describe("PushCandidateReactor", () => {
  it.effect("starts at the head of the event log on first boot", () =>
    withPushWorld((world) =>
      Effect.gen(function* () {
        yield* world.putShell(
          threadShell("thread", { status: "completed", activityRunStatus: null }),
        );
        yield* runEvent(world, "thread", "thread-run-1", "completed");
        yield* Effect.gen(function* () {
          yield* register;
          yield* drain;
          assert.strictEqual(yield* cursor, 1);
          assert.deepStrictEqual(yield* deliveries, []);
        }).pipe(Effect.provide(layerPushServices));
      }),
    ),
  );

  it.effect("records a delivery per attention change and resumes from its cursor", () =>
    withPushWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* register;
          yield* world.putShell(threadShell("thread"));
          yield* runEvent(world, "thread", "thread-run-1", "running");
          yield* drain;
          assert.deepStrictEqual(yield* deliveries, []);

          yield* world.putShell(
            threadShell("thread", { status: "completed", activityRunStatus: null }),
          );
          yield* runEvent(world, "thread", "thread-run-1", "completed");
          yield* drain;
        }).pipe(Effect.provide(layerPushServices));

        const now = DateTime.toEpochMillis(yield* DateTime.now);
        assert.deepStrictEqual(yield* deliveries, [
          {
            thread_id: "thread",
            attention_key: "completion:thread-run-1",
            kind: "completion",
            status: "pending",
            occurred_at: now,
            expires_at: now + 10 * 60_000,
            next_attempt_at: now + 2_000,
          },
        ]);

        yield* Effect.gen(function* () {
          yield* drain;
          assert.lengthOf(yield* deliveries, 1);

          yield* world.putShell(threadShell("thread", { latestRunId: RunId.make("thread-run-2") }));
          yield* runEvent(world, "thread", "thread-run-2", "running");
          yield* drain;
          assert.deepStrictEqual(
            (yield* deliveries).map((row) => row.status),
            ["cancelled"],
          );

          yield* world.putShell(
            threadShell("thread", {
              latestRunId: RunId.make("thread-run-2"),
              status: "failed",
              activityRunStatus: null,
            }),
          );
          yield* Effect.flatMap(DateTime.now, (occurredAt) =>
            world.appendEvent(
              {
                type: "run.updated",
                threadId: "thread",
                occurredAt,
                payload: { id: RunId.make("thread-run-2"), status: "failed" },
              },
              "command:runtime-reconcile:startup:thread:1970-01-01T00:00:00.000Z",
            ),
          );
          yield* drain;
          assert.lengthOf(yield* deliveries, 1);
          assert.strictEqual(yield* cursor, 4);
        }).pipe(Effect.provide(layerPushServices));
      }),
    ),
  );

  it.effect("lifts a subagent's question to its parent until the user pauses it", () =>
    withPushWorld((world) =>
      Effect.gen(function* () {
        yield* register;
        const requestId = RuntimeRequestId.make("question-1");
        const now = yield* DateTime.now;
        yield* world.putShell(threadShell(PARENT));
        yield* Ref.set(world.subagents, new Map([[PARENT, [subagentRecord(CHILD)]]]));
        yield* runEvent(world, PARENT, "parent-run-1", "running");
        yield* drain;

        yield* world.putShell(
          threadShell(CHILD, {
            lineage: {
              rootThreadId: PARENT,
              parentThreadId: PARENT,
              relationshipToParent: "subagent",
            },
            creationSource: "mcp",
            pendingRuntimeRequest: { id: requestId, kind: "user_input", createdAt: now },
          }),
        );
        yield* Ref.set(
          world.runtimeRequests,
          new Map([
            [
              requestId,
              {
                id: requestId,
                kind: "user_input",
                status: "pending",
                nativeRequestRef: { driver: "codex", nativeId: "native-1" },
                responseCapability: { type: "message" },
                createdAt: now,
              } as unknown as OrchestrationV2RuntimeRequest,
            ],
          ]),
        );
        yield* world.appendEvent({
          type: "runtime-request.updated",
          threadId: CHILD,
          occurredAt: now,
          payload: { id: requestId, status: "pending" },
        });
        yield* drain;

        const millis = DateTime.toEpochMillis(now);
        assert.deepStrictEqual(yield* deliveries, [
          {
            thread_id: "parent",
            attention_key: "input:child:question-1",
            kind: "input",
            status: "pending",
            occurred_at: millis,
            expires_at: millis + 120_000,
            next_attempt_at: millis,
          },
        ]);

        yield* world.appendEvent({
          type: "runtime-request.updated",
          threadId: CHILD,
          occurredAt: now,
          payload: { id: requestId, status: "pending", autoDismissPaused: true },
        });
        yield* drain;
        assert.deepStrictEqual(
          (yield* deliveries).map((row) => row.status),
          ["cancelled"],
        );
      }).pipe(Effect.provide(layerPushServices)),
    ),
  );

  it.effect("skips kinds a registration turned off", () =>
    withPushWorld((world) =>
      Effect.gen(function* () {
        yield* insertSession(SESSION);
        const { publicKey } = yield* recipientKeyPair;
        yield* (yield* PushNotifications.PushNotifications).register(
          SESSION,
          registerInput(REGISTRATION_ID, publicKey, {
            kinds: {
              approval: true,
              input: true,
              completion: false,
              failure: true,
              "usage-limit": true,
            },
          }),
        );
        yield* world.putShell(threadShell("thread"));
        yield* runEvent(world, "thread", "thread-run-1", "running");
        yield* drain;
        yield* world.putShell(
          threadShell("thread", { status: "completed", activityRunStatus: null }),
        );
        yield* runEvent(world, "thread", "thread-run-1", "completed");
        yield* drain;
        assert.deepStrictEqual(yield* deliveries, []);
      }).pipe(Effect.provide(layerPushServices)),
    ),
  );
});
