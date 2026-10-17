import type { EnvironmentConnectionPhase } from "@supaterm/client-runtime/connection";
import type { EnvironmentId } from "@supaterm/contracts";

import { CONNECTION_STATUS_DELAY_MS } from "./status-delay";

export interface DelayedEnvironmentConnectionState {
  readonly environmentId: EnvironmentId;
  readonly connectionState: EnvironmentConnectionPhase;
}

function isPendingConnection(state: EnvironmentConnectionPhase | undefined): boolean {
  return state === "connecting" || state === "reconnecting";
}

function sameSet(left: ReadonlySet<EnvironmentId>, right: ReadonlySet<EnvironmentId>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

export function createDelayedEnvironmentConnectionVisibility(
  onChange: (connected: ReadonlySet<EnvironmentId>) => void,
  initialVisible: ReadonlySet<EnvironmentId> = new Set(),
) {
  let latest = new Map<EnvironmentId, EnvironmentConnectionPhase>();
  let visible = new Set(initialVisible);
  const timers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
  let active = true;

  const clearTimer = (environmentId: EnvironmentId) => {
    const timer = timers.get(environmentId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(environmentId);
  };

  const emit = (next: Set<EnvironmentId>) => {
    if (sameSet(visible, next)) return;
    visible = next;
    onChange(new Set(next));
  };

  const update = (states: ReadonlyArray<DelayedEnvironmentConnectionState>, isActive: boolean) => {
    active = isActive;
    latest = new Map(states.map((state) => [state.environmentId, state.connectionState]));
    const next = new Set(visible);
    const known = new Set(latest.keys());

    for (const environmentId of next) {
      if (!known.has(environmentId)) {
        next.delete(environmentId);
        clearTimer(environmentId);
      }
    }
    for (const environmentId of timers.keys()) {
      if (!known.has(environmentId)) clearTimer(environmentId);
    }
    for (const [environmentId, state] of latest) {
      if (state === "connected") {
        clearTimer(environmentId);
        next.add(environmentId);
        continue;
      }
      if (!isPendingConnection(state)) {
        clearTimer(environmentId);
        next.delete(environmentId);
        continue;
      }
      if (!isActive) {
        clearTimer(environmentId);
        continue;
      }
      if (!next.has(environmentId) || timers.has(environmentId)) continue;
      timers.set(
        environmentId,
        setTimeout(() => {
          timers.delete(environmentId);
          if (!active || !isPendingConnection(latest.get(environmentId))) return;
          const expired = new Set(visible);
          expired.delete(environmentId);
          emit(expired);
        }, CONNECTION_STATUS_DELAY_MS),
      );
    }
    emit(next);
  };

  return {
    update,
    dispose() {
      for (const environmentId of timers.keys()) clearTimer(environmentId);
    },
  };
}
