import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BackgroundSync from "./backgroundSync.ts";
import { ENVIRONMENT_ID } from "./backgroundSyncTestFixtures.ts";
import * as BackgroundSyncTask from "./task.ts";

const environment = (
  overrides: Partial<BackgroundSync.EnvironmentSyncReport>,
): BackgroundSync.EnvironmentSyncReport => ({
  environmentId: ENVIRONMENT_ID,
  status: "synced",
  route: { id: "lan", kind: "lan" },
  shell: { _tag: "unchanged", sequence: 4 },
  threads: [],
  error: null,
  ...overrides,
});

const report = (
  outcome: BackgroundSync.BackgroundSyncReport["outcome"],
  environments: ReadonlyArray<BackgroundSync.EnvironmentSyncReport>,
): BackgroundSync.BackgroundSyncReport => ({ outcome, durationMs: 0, environments, error: null });

describe("background sync task", () => {
  it.each([
    [
      "new-data when a deadline stop already stored a snapshot",
      report("deadline", [
        environment({ shell: { _tag: "saved", sequence: 5, previousSequence: 4 } }),
      ]),
      "new-data",
    ],
    [
      "no-data when every cached snapshot was current",
      report("completed", [environment({})]),
      "no-data",
    ],
    [
      "failed when no environment could be reached, so the scheduler retries",
      report("completed", [environment({ status: "unreachable", route: null, shell: null })]),
      "failed",
    ],
    ["no-data when nothing is paired", report("completed", []), "no-data"],
  ] as const)("reports %s", (_, value, completion) => {
    expect(BackgroundSyncTask.completionFor(value)).toBe(completion);
  });

  it("runs one task at a time in a runtime that is gone when the task ends", async () => {
    const requests: Array<BackgroundSync.BackgroundSyncRequest> = [];
    const lifecycle: Array<string> = [];
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const layer = Layer.effect(
      BackgroundSync.BackgroundSync,
      Effect.gen(function* () {
        lifecycle.push("built");
        yield* Effect.addFinalizer(() => Effect.sync(() => lifecycle.push("disposed")));
        return BackgroundSync.BackgroundSync.of({
          run: (request) =>
            Effect.promise(() => gate).pipe(
              Effect.as(report("completed", [environment({})])),
              Effect.tap(() => Effect.sync(() => requests.push(request))),
            ),
        });
      }),
    );
    const runTask = BackgroundSyncTask.makeTaskRunner(layer);

    const first = runTask({ trigger: "app-refresh", platformBudgetMs: 30_000 });
    const overlapping = await runTask({ trigger: "notification", platformBudgetMs: 30_000 });
    open();
    const completed = await first;
    const next = runTask({ trigger: "app-refresh", platformBudgetMs: 30_000 });
    await next;

    expect(overlapping.report.outcome).toBe("busy");
    expect(completed.completion).toBe("no-data");
    expect(requests.map((request) => request.budgetMs)).toEqual([
      30_000 - BackgroundSyncTask.COMPLETION_RESERVE_MS,
      30_000 - BackgroundSyncTask.COMPLETION_RESERVE_MS,
    ]);
    expect(lifecycle).toEqual(["built", "disposed", "built", "disposed"]);
  });
});
