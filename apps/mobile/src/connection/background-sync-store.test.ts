import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestrationV2ThreadBoundedSnapshot } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SQLiteDatabase } from "expo-sqlite";

import { make } from "./background-sync-store";

const environmentId = EnvironmentId.make("background-store");
const shell = (sequence: number) => ({
  kind: "shell" as const,
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: sequence,
    projects: [],
    threads: [],
    archivedThreads: [],
  },
});
const thread = {
  kind: "thread" as const,
  snapshot: Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot))({
    snapshotSequence: 12,
    historyCursor: "page-2",
    hasMoreHistory: true,
    latestLocalTurnOrdinal: 20,
    payloadBudgetExceeded: false,
    projection: {
      thread: {
        createdBy: "user",
        creationSource: "mobile",
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
        forkedFrom: null,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  }),
};

const openStore = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(":memory:")),
    (database) => Effect.sync(() => database.close()),
  );
  const adapter = {
    execSync: (sql: string) => database.exec(sql),
    runSync: (sql: string, ...params: Array<string | number>) => {
      const result = database.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getFirstSync: (sql: string, ...params: Array<string | number>) =>
      database.prepare(sql).get(...params) ?? null,
  } as Pick<SQLiteDatabase, "execSync" | "runSync" | "getFirstSync">;
  return { database, store: yield* make(adapter) };
});

describe("background snapshot persistence", () => {
  it.effect(
    "rejects stale and equal writes atomically without rewinding the snapshot or its cursor",
    () =>
      Effect.gen(function* () {
        const { store, database } = yield* openStore;
        expect(yield* store.save(environmentId, shell(20))).toBe(true);
        expect(yield* store.save(environmentId, shell(10))).toBe(false);
        expect(yield* store.save(environmentId, shell(20))).toBe(false);
        expect(Option.getOrThrow(yield* store.load(environmentId, "shell"))).toEqual(shell(20));
        expect(yield* store.save(environmentId, thread)).toBe(true);
        const older = {
          ...thread,
          snapshot: { ...thread.snapshot, snapshotSequence: 11, historyCursor: "old-page" },
        };
        expect(yield* store.save(environmentId, older)).toBe(false);
        const restored = Option.getOrThrow(yield* store.load(environmentId, "thread:thread-1"));
        expect(restored).toEqual(thread);
        expect(
          database
            .prepare("SELECT sequence FROM background_snapshot WHERE snapshot_key = ?")
            .get("thread:thread-1"),
        ).toMatchObject({ sequence: 12 });
      }),
  );

  it.effect("stores environment and stream positions independently", () =>
    Effect.gen(function* () {
      const { store } = yield* openStore;
      const other = EnvironmentId.make("other");
      yield* store.save(environmentId, shell(100));
      yield* store.save(environmentId, thread);
      yield* store.save(other, shell(2));
      expect(
        Option.getOrThrow(yield* store.load(environmentId, "shell")).snapshot.snapshotSequence,
      ).toBe(100);
      expect(Option.getOrThrow(yield* store.load(other, "shell")).snapshot.snapshotSequence).toBe(
        2,
      );
      expect(Option.isNone(yield* store.load(other, "thread:thread-1"))).toBe(true);
    }),
  );
});
