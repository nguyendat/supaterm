import type { OrchestrationV2DomainEvent, OrchestrationV2ThreadShell } from "@supacode/contracts";
import type { PushNotificationKind } from "@supacode/contracts/push";

import {
  backgroundWorkHoldsCompletion,
  turnItemUpdateCanEndBackgroundWork,
} from "./orchestrationV2PendingBackgroundWork.ts";

export function eventChangesNotificationAttention(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "run.created":
    case "run.updated":
    case "run.background-work-cancelled":
    case "runtime-request.updated":
    case "provider-thread.updated":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.pull-request-synced":
      return true;
    case "turn-item.updated":
      return turnItemUpdateCanEndBackgroundWork(event.payload);
    default:
      return false;
  }
}

type NotificationAttentionInput = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "lineage"
  | "latestRunId"
  | "pendingRuntimeRequest"
  | "activityRunStatus"
  | "status"
  | "lastErrorClass"
  | "pendingBackgroundTasks"
>;

function notificationKind(thread: NotificationAttentionInput): PushNotificationKind | null {
  const request = thread.pendingRuntimeRequest;
  if (request?.kind === "user_input") return "input";
  if (request !== null && request.kind !== "auth_refresh") return "approval";
  if (thread.activityRunStatus != null) return null;
  if (thread.status === "failed")
    return thread.lastErrorClass === "usage_limit" ? "usage-limit" : "failure";
  if (
    thread.status === "completed" &&
    !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  )
    return "completion";
  return null;
}

export function threadNotificationAttention(thread: NotificationAttentionInput) {
  if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") return null;
  const kind = notificationKind(thread);
  return kind === null
    ? null
    : {
        kind,
        key: `${thread.latestRunId ?? ""}:${kind}:${thread.pendingRuntimeRequest?.id ?? ""}`,
      };
}
