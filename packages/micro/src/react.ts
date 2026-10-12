import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { MicroController } from "./controller.ts";
import type { MicroAction } from "./input.ts";
import type { DesktopBridge } from "@supacode/contracts";
import { DesktopMicroHid } from "./desktopHid.ts";

let controller: MicroController | undefined;

export function getMicroController(): MicroController {
  if (!controller) {
    let storage: Storage | null = null;
    try {
      storage = typeof window === "undefined" ? null : window.localStorage;
    } catch {}
    const bridge =
      typeof window === "undefined"
        ? undefined
        : (window as Window & { desktopBridge?: DesktopBridge }).desktopBridge?.micro;
    controller = new MicroController(bridge ? new DesktopMicroHid(bridge) : null, storage);
  }
  return controller;
}

export function useMicro() {
  const micro = getMicroController();
  return useSyncExternalStore(micro.subscribe, micro.getSnapshot, micro.getSnapshot);
}

export function useMicroActions(handler: (action: MicroAction) => void, enabled = true): void {
  const onAction = useEffectEvent(handler);
  useEffect(() => {
    if (enabled) return getMicroController().subscribeActions(onAction);
  }, [enabled]);
}
