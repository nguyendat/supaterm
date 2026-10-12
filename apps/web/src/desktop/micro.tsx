import { useMicroActions as useDeviceActions } from "@supacode/micro/react";
import { useMicroComposer as useDeviceComposer } from "@supacode/micro/composer";
import { isElectron } from "../env";

export { MicroCoordinator } from "../components/desktop/MicroCoordinator";

export const useMicroActions: typeof useDeviceActions = (handler) =>
  useDeviceActions(handler, isElectron);

export const useMicroComposer: typeof useDeviceComposer = (input) =>
  useDeviceComposer({ ...input, enabled: isElectron });
