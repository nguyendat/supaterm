import { WS_METHODS } from "@supaterm/contracts";
import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "@supaterm/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

const registrations = createEnvironmentGuardedRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:push:list",
  tag: WS_METHODS.pushList,
  staleTimeMs: 30_000,
});

export const pushEnvironment = {
  registrations,
  test: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:push:test",
    tag: WS_METHODS.pushTest,
    onSettled: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(registrations({ environmentId, input: {} }))),
  }),
  revoke: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:push:revoke",
    tag: WS_METHODS.pushRevoke,
    onSettled: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(registrations({ environmentId, input: {} }))),
  }),
};
