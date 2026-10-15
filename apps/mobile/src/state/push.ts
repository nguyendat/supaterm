import { WS_METHODS, type EnvironmentId } from "@supaterm/contracts";
import type {
  PushEnrollmentData,
  PushNotificationData,
  PushRegistration,
} from "@supaterm/contracts/push";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@supaterm/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

export const pushCommands = {
  state: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notification state",
    tag: WS_METHODS.pushState,
  }),
  register: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notification registration",
    tag: WS_METHODS.pushRegister,
    concurrency: { mode: "serial", key: (target) => target.environmentId },
  }),
  confirm: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notification confirmation",
    tag: WS_METHODS.pushConfirm,
  }),
  preferences: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notification preferences",
    tag: WS_METHODS.pushPreferences,
  }),
  revoke: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notification revocation",
    tag: WS_METHODS.pushRevoke,
  }),
  presence: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notification presence",
    tag: WS_METHODS.pushPresence,
  }),
  resolve: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notification resolution",
    tag: WS_METHODS.pushResolve,
  }),
};

export async function runPushCommand<I, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  environmentId: EnvironmentId,
  input: I,
): Promise<A> {
  const result = await command.run(appAtomRegistry, { environmentId, input });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export const pushRegistrationAtom = Atom.family((_id: EnvironmentId) =>
  Atom.make<{
    readonly registration: PushRegistration | null;
    readonly status: "loading" | "ready" | "registering" | "failed";
  }>({ registration: null, status: "loading" }).pipe(Atom.keepAlive),
);

export const pendingPushTapAtom = Atom.make<typeof PushNotificationData.Type | null>(null).pipe(
  Atom.keepAlive,
);
export const pushEnrollmentChallengeAtom = Atom.make<typeof PushEnrollmentData.Type | null>(
  null,
).pipe(Atom.keepAlive);
