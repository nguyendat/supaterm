import { getMicroController, useMicro, useMicroActions } from "@supacode/micro/react";
import { resolveMicroThreadStatus } from "@supacode/micro/status";
import { MICRO_SLOTS } from "@supacode/micro/protocol";
import type { ScopedThreadRef } from "@supacode/contracts";
import { isEnvironmentConnected } from "@supacode/client-runtime/connection";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell, useThreadShell } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { buildThreadRouteParams } from "../../threadRoutes";

function MicroSlot({ slot, threadRef }: { slot: number; threadRef: ScopedThreadRef | null }) {
  const thread = useThreadShell(threadRef);
  const { presentation } = useEnvironmentPresentation(threadRef?.environmentId ?? null);
  const status = resolveMicroThreadStatus(
    thread,
    presentation?.entry.enabled === true && isEnvironmentConnected(presentation),
  );
  useEffect(() => {
    getMicroController().setSlotStatus(slot, status);
  }, [slot, status]);
  useEffect(() => () => getMicroController().setSlotStatus(slot, "unavailable"), [slot]);
  return null;
}

export function MicroCoordinator() {
  const snapshot = useMicro();
  const navigate = useNavigate();
  useMicroActions((action) => {
    if (action.type !== "thread") return;
    const assignment = snapshot.config.slots[action.slot];
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    if (
      assignment &&
      catalog.entries.get(assignment.environmentId)?.enabled &&
      readThreadShell(assignment)
    )
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(assignment),
      });
    else void navigate({ to: "/settings/micro" });
  });
  useEffect(() => {
    const micro = getMicroController();
    return () => {
      void micro.disconnect();
    };
  }, []);
  if (snapshot.phase !== "connected") return null;
  return MICRO_SLOTS.map((slot) => (
    <MicroSlot key={slot} slot={slot} threadRef={snapshot.config.slots[slot] ?? null} />
  ));
}
