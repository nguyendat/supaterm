import { getMicroController, useMicro, useMicroActions } from "@supacode/micro/react";
import { resolveMicroThreadStatus } from "@supacode/micro/status";
import { MICRO_SLOTS } from "@supacode/micro/protocol";
import type { ScopedThreadRef } from "@supacode/contracts";
import { isEnvironmentConnected } from "@supacode/client-runtime/connection";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useThreadRefs, useThreadShell } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { buildThreadRouteParams } from "../../threadRoutes";

function MicroSlot({ slot, threadRef }: { slot: number; threadRef: ScopedThreadRef | null }) {
  const thread = useThreadShell(threadRef);
  const { presentation } = useEnvironmentPresentation(threadRef?.environmentId ?? null);
  const status = resolveMicroThreadStatus(thread, isEnvironmentConnected(presentation));
  useEffect(() => {
    getMicroController().setSlotStatus(slot, status);
  }, [slot, status]);
  useEffect(() => () => getMicroController().setSlotStatus(slot, "unavailable"), [slot]);
  return null;
}

export function MicroCoordinator() {
  const snapshot = useMicro();
  const refs = useThreadRefs();
  const navigate = useNavigate();
  useMicroActions((action) => {
    if (action.type !== "thread") return;
    const assignment = snapshot.config.slots[action.slot];
    const ref =
      assignment &&
      refs.find(
        (candidate) =>
          candidate.environmentId === assignment.environmentId &&
          candidate.threadId === assignment.threadId,
      );
    if (ref)
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    else void navigate({ to: "/settings/general", hash: "micro-controller" });
  });
  useEffect(() => {
    const micro = getMicroController();
    return () => {
      void micro.disconnect();
    };
  }, []);
  if (snapshot.phase !== "connected") return null;
  return MICRO_SLOTS.map((slot) => (
    <MicroSlot
      key={slot}
      slot={slot}
      threadRef={
        snapshot.config.slots[slot]
          ? (refs.find(
              (ref) =>
                ref.environmentId === snapshot.config.slots[slot]?.environmentId &&
                ref.threadId === snapshot.config.slots[slot]?.threadId,
            ) ?? null)
          : null
      }
    />
  ));
}
