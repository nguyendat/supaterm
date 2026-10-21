import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TailnetConfigureInput, TailnetSignInInput } from "@supaterm/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@supaterm/client-runtime/state/runtime";
import type { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type TailnetOperation,
  activeTailnetOperation,
  canStartTailnetOperation,
} from "./TailscaleSettings.logic";

export type TailnetOperations = ReturnType<typeof useTailnetOperations>;

export function commandFailureMessage(
  failure: AsyncResult.Failure<unknown, unknown>,
  fallback: string,
): string {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function reportTailnetFailure(
  title: string,
  failure: AsyncResult.Failure<unknown, unknown>,
) {
  if (isAtomCommandInterrupted(failure)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: commandFailureMessage(failure, "Try again."),
    }),
  );
}

export function useTailnetOperations(environmentId: EnvironmentId) {
  const signIn = useAtomCommand(serverEnvironment.tailnetSignIn, { reportFailure: false });
  const cancelSignIn = useAtomCommand(serverEnvironment.tailnetCancelSignIn, {
    reportFailure: false,
  });
  const reauthenticate = useAtomCommand(serverEnvironment.tailnetReauthenticate, {
    reportFailure: false,
  });
  const signOut = useAtomCommand(serverEnvironment.tailnetSignOut, { reportFailure: false });
  const configure = useAtomCommand(serverEnvironment.tailnetConfigure, { reportFailure: false });
  const canSignIn = useAtomValue(serverEnvironment.tailnetSignIn.permissionAtom(environmentId));
  const canCancelSignIn = useAtomValue(
    serverEnvironment.tailnetCancelSignIn.permissionAtom(environmentId),
  );
  const canReauthenticate = useAtomValue(
    serverEnvironment.tailnetReauthenticate.permissionAtom(environmentId),
  );
  const canSignOut = useAtomValue(serverEnvironment.tailnetSignOut.permissionAtom(environmentId));
  const canConfigure = useAtomValue(
    serverEnvironment.tailnetConfigure.permissionAtom(environmentId),
  );
  const [inFlight, setInFlight] = useState<ReadonlyArray<TailnetOperation>>([]);

  const active = activeTailnetOperation(inFlight);
  const available = {
    "sign-in": canSignIn && canStartTailnetOperation(active, "sign-in"),
    "cancel-sign-in": canCancelSignIn && canStartTailnetOperation(active, "cancel-sign-in"),
    reauthenticate: canReauthenticate && canStartTailnetOperation(active, "reauthenticate"),
    "sign-out": canSignOut && canStartTailnetOperation(active, "sign-out"),
    configure: canConfigure && canStartTailnetOperation(active, "configure"),
  };

  const run = async <A, E>(
    operation: TailnetOperation,
    execute: () => Promise<AtomCommandResult<A, E>>,
  ) => {
    if (!available[operation.kind]) return null;
    setInFlight((current) => [...current, operation]);
    const result = await execute();
    setInFlight((current) => current.filter((entry) => entry !== operation));
    return result;
  };

  return {
    active,
    available,
    pendingPatch: active?.kind === "configure" ? active.patch : null,
    signIn: (input: TailnetSignInInput) =>
      run({ kind: "sign-in" }, () => signIn({ environmentId, input })),
    cancelSignIn: () =>
      run({ kind: "cancel-sign-in" }, () => cancelSignIn({ environmentId, input: {} })),
    reauthenticate: () =>
      run({ kind: "reauthenticate" }, () => reauthenticate({ environmentId, input: {} })),
    signOut: () => run({ kind: "sign-out" }, () => signOut({ environmentId, input: {} })),
    configure: (patch: TailnetConfigureInput) =>
      run({ kind: "configure", patch }, () => configure({ environmentId, input: patch })),
  };
}
