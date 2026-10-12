import type { EnvironmentThreadShell } from "@supacode/client-runtime/state/shell";
import { backgroundWorkHoldsCompletion } from "@supacode/shared/orchestrationV2PendingBackgroundWork";
import type { MicroThreadStatus } from "./protocol.ts";

export function resolveMicroThreadStatus(
  thread: Pick<
    EnvironmentThreadShell,
    | "archivedAt"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "runtime"
    | "latestRun"
    | "pendingBackgroundTasks"
    | "hasActionableProposedPlan"
    | "interactionMode"
  > | null,
  connected: boolean,
): MicroThreadStatus {
  if (!connected || !thread || thread.archivedAt !== null) return "unavailable";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "input";
  const runtime = thread.runtime;
  if (runtime && ["preparing", "queued", "starting", "running", "waiting"].includes(runtime.status))
    return "working";
  if (runtime?.status === "failed" || thread.latestRun?.status === "failed") return "error";
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks)) return "working";
  if (
    thread.hasActionableProposedPlan &&
    thread.interactionMode === "plan" &&
    thread.latestRun?.status === "completed" &&
    runtime?.activeRunId !== thread.latestRun.runId
  )
    return "input";
  if (thread.latestRun?.status === "completed") return "complete";
  return "idle";
}
