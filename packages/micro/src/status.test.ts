import { RunId } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveMicroThreadStatus } from "./status.ts";

const idle = {
  archivedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  runtime: null,
  latestRun: null,
  pendingBackgroundTasks: [],
  hasActionableProposedPlan: false,
  interactionMode: "default",
} satisfies NonNullable<Parameters<typeof resolveMicroThreadStatus>[0]>;
const completed = {
  ...idle,
  latestRun: {
    runId: RunId.make("run-1"),
    status: "completed",
    requestedAt: null,
    startedAt: null,
    completedAt: "2026-10-12T12:00:00Z",
    assistantMessageId: null,
  },
} satisfies NonNullable<Parameters<typeof resolveMicroThreadStatus>[0]>;

describe("Micro thread LEDs", () => {
  it("dims unavailable threads and gives pending input priority", () => {
    expect(resolveMicroThreadStatus(completed, false)).toBe("unavailable");
    expect(
      resolveMicroThreadStatus({ ...completed, archivedAt: "2026-10-12T12:00:00Z" }, true),
    ).toBe("unavailable");
    expect(resolveMicroThreadStatus({ ...completed, hasPendingApprovals: true }, true)).toBe(
      "input",
    );
    expect(resolveMicroThreadStatus({ ...completed, hasPendingUserInput: true }, true)).toBe(
      "input",
    );
  });

  it("shows plan attention only for a completed run in plan mode", () => {
    expect(resolveMicroThreadStatus({ ...completed, hasActionableProposedPlan: true }, true)).toBe(
      "complete",
    );
    expect(
      resolveMicroThreadStatus(
        { ...completed, hasActionableProposedPlan: true, interactionMode: "plan" },
        true,
      ),
    ).toBe("input");
    expect(
      resolveMicroThreadStatus(
        { ...idle, hasActionableProposedPlan: true, interactionMode: "plan" },
        true,
      ),
    ).toBe("idle");
  });

  it("distinguishes failed, completed, and idle runs", () => {
    expect(resolveMicroThreadStatus(idle, true)).toBe("idle");
    expect(resolveMicroThreadStatus(completed, true)).toBe("complete");
    expect(
      resolveMicroThreadStatus(
        { ...completed, latestRun: { ...completed.latestRun, status: "failed" } },
        true,
      ),
    ).toBe("error");
  });
});
