import type {
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjection,
} from "@supacode/contracts";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";
import type { ThreadSnapshotHistoryMeta } from "./threadSnapshotHttp.ts";

export function historyFromHttpSnapshot(
  history: ThreadSnapshotHistoryMeta | undefined,
): ThreadHistoryMeta {
  return history === undefined
    ? EMPTY_THREAD_HISTORY_META
    : {
        historyCursor: history.historyCursor,
        hasMoreHistory: history.hasMoreHistory,
        loading: false,
        error: null,
        expanded: false,
        latestLocalTurnOrdinal: history.latestLocalTurnOrdinal ?? null,
      };
}

export function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
  acceptsBoundedSnapshots: boolean,
): OrchestrationV2ThreadDetailSnapshot {
  // A complete bounded snapshot still proves paging support. Retain that evidence
  // so a thread that grows while closed can resume with a bounded fallback.
  if (acceptsBoundedSnapshots || history.hasMoreHistory || history.historyCursor !== null) {
    return {
      snapshotSequence,
      projection,
      historyCursor: history.historyCursor,
      hasMoreHistory: history.hasMoreHistory,
      latestLocalTurnOrdinal: history.latestLocalTurnOrdinal,
    };
  }
  return { snapshotSequence, projection };
}

export function shouldPersistThread(
  thread: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): boolean {
  // After the user loads older pages the in-memory timeline can grow large.
  // Keep those expanded projections out of the monolithic cache.
  if (history.expanded) {
    return false;
  }
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}
