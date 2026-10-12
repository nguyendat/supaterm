import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { MicroController } from "./controller.ts";
import type { MicroAction } from "./input.ts";
import type { MicroHid } from "./hid.ts";

let controller: MicroController | undefined;

export function getMicroController(): MicroController {
  if (!controller) {
    let storage: Storage | null = null;
    try {
      storage = typeof window === "undefined" ? null : window.localStorage;
    } catch {}
    controller = new MicroController(
      typeof navigator !== "undefined" && "hid" in navigator ? (navigator.hid as MicroHid) : null,
      storage,
    );
  }
  return controller;
}

export function useMicro() {
  const micro = getMicroController();
  return useSyncExternalStore(micro.subscribe, micro.getSnapshot, micro.getSnapshot);
}

export function useMicroActions(handler: (action: MicroAction) => void): void {
  const onAction = useEffectEvent(handler);
  useEffect(() => getMicroController().subscribeActions(onAction), []);
}
