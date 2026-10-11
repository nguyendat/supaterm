import { AlertCircleIcon } from "lucide-react";
import { type RefObject, useState } from "react";

import { Button } from "../ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";

export function PairingConnectionSetup({
  buttonRef,
  canEnableRelay,
  canEnableNetworkAccess,
  stage,
  error,
  onEnable,
  onCancel,
}: {
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly canEnableRelay: boolean;
  readonly canEnableNetworkAccess: boolean;
  readonly stage: "idle" | "enabling-relay" | "network";
  readonly error: string | null;
  readonly onEnable: (method: "relay" | "network") => void;
  readonly onCancel: () => void;
}) {
  const [method, setMethod] = useState<"relay" | "network">(
    canEnableRelay || !canEnableNetworkAccess ? "relay" : "network",
  );
  const pending = stage !== "idle";
  const canEnable = method === "relay" ? canEnableRelay : canEnableNetworkAccess;
  const buttonLabel = pending
    ? stage === "network"
      ? "Restarting…"
      : "Enabling relay…"
    : method === "relay"
      ? "Enable relay and continue"
      : "Restart and enable";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect another device</DialogTitle>
        <DialogDescription>
          Choose how your other device will reach this environment before creating a pairing link.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <RadioGroup
          aria-label="Connection method"
          value={method}
          disabled={pending}
          onValueChange={(value) => {
            if (value === "relay" || value === "network") setMethod(value);
          }}
        >
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-input p-4 has-disabled:cursor-default">
            <Radio value="relay" disabled={!canEnableRelay} />
            <span className="space-y-1">
              <span className="block text-sm font-medium">Public relay</span>
              <span className="block text-xs leading-5 text-muted-foreground">
                Connect from anywhere with end-to-end encryption. No restart needed.
              </span>
            </span>
          </label>
          {canEnableNetworkAccess ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-input p-4 has-disabled:cursor-default">
              <Radio value="network" />
              <span className="space-y-1">
                <span className="block text-sm font-medium">Network access</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  Connect directly over your local network. Supacode will restart, then reopen Add
                  device.
                </span>
              </span>
            </label>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              For a direct local connection, enable Network access on the host in the desktop app or
              restart the server with network access enabled.
            </p>
          )}
        </RadioGroup>
        {!canEnableRelay && !canEnableNetworkAccess ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Ask the host owner to enable Public relay or Network access, then add this device.
          </p>
        ) : null}
        {error ? (
          <p className="flex items-start gap-2 text-xs leading-5 text-destructive" role="alert">
            <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button size="comfortable" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          ref={buttonRef}
          size="comfortable"
          disabled={pending || !canEnable}
          aria-busy={pending}
          onClick={() => onEnable(method)}
        >
          {pending ? <Spinner /> : null}
          <span aria-live="polite">{buttonLabel}</span>
        </Button>
      </DialogFooter>
    </>
  );
}
