import { useEffect, useState } from "react";
import { AppState } from "react-native";
import type { EnvironmentId } from "@supaterm/contracts";

import type { DelayedEnvironmentConnectionState } from "./delayed-environment-connections";
import { createDelayedEnvironmentConnectionVisibility } from "./delayed-environment-connections";

export type { DelayedEnvironmentConnectionState } from "./delayed-environment-connections";

function connectedEnvironmentIds(
  states: ReadonlyArray<DelayedEnvironmentConnectionState>,
): ReadonlySet<EnvironmentId> {
  const connected = new Set<EnvironmentId>();
  for (const state of states) {
    if (state.connectionState === "connected") connected.add(state.environmentId);
  }
  return connected;
}

export function useDelayedEnvironmentConnections(
  states: ReadonlyArray<DelayedEnvironmentConnectionState>,
): ReadonlySet<EnvironmentId> {
  const [active, setActive] = useState(() => AppState.currentState === "active");
  const [visible, setVisible] = useState<ReadonlySet<EnvironmentId>>(() =>
    connectedEnvironmentIds(states),
  );
  const [controller] = useState(() =>
    createDelayedEnvironmentConnectionVisibility(setVisible, visible),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    controller.update(states, active);
  }, [active, controller, states]);

  useEffect(() => () => controller.dispose(), [controller]);

  return visible;
}
