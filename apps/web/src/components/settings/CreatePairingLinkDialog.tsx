import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthGrantScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  type AuthPairingCredentialResult,
  type RelayConnectionInfo,
} from "@supacode/contracts";
import { squashAtomCommandFailure } from "@supacode/client-runtime/state/runtime";
import { AUTH_SCOPE_OPTIONS } from "@supacode/shared/authScopeOptions";
import { LinkIcon, PlusIcon } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";

import { createServerPairingCredential } from "~/environments/primary";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { clearPairingSetupResume, readPairingSetupResume } from "~/lib/pairingSetupResume";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { togglePairingScopeSelection } from "./ConnectionsSettings.logic";
import { PairingConnectionSetup } from "./PairingConnectionSetup";

const PERMISSION_SCOPES = {
  standard: AuthStandardClientScopes,
  "full-access": AuthGrantScope.literals,
  "read-only": [
    AuthOrchestrationReadScope,
    AuthFilesystemReadScope,
    AuthDiagnosticsReadScope,
    AuthTerminalReadScope,
  ],
};

const PERMISSION_PRESETS = [
  {
    value: "standard",
    label: "Standard",
    description:
      "Run agents, work with files, and use terminals with the permissions you can share.",
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Share every permission you can grant, including device access management.",
  },
  {
    value: "read-only",
    label: "Read only",
    description: "Follow threads, browse files, and view terminal output without making changes.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Choose which of your permissions to share with this device.",
  },
] as const;

export function CreatePairingLinkDialog({
  triggerRef,
  relayEnabled,
  hasShareableEndpoint,
  connectionLoading,
  onEnableNetworkAccess,
  delegatableScopes,
  onPairingLinkCreated,
}: {
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly relayEnabled: boolean;
  readonly hasShareableEndpoint: boolean;
  readonly connectionLoading: boolean;
  readonly onEnableNetworkAccess?: (() => Promise<boolean>) | undefined;
  readonly delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly onPairingLinkCreated: (
    result: AuthPairingCredentialResult,
    relay?: RelayConnectionInfo,
  ) => void;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const prepareRelay = useAtomCommand(serverEnvironment.prepareRelay, { reportFailure: false });
  const canPrepareRelay = useAtomValue(
    serverEnvironment.prepareRelay.permissionAtom(primaryEnvironmentId),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canUpdateSettings = useEnvironmentScope(primaryEnvironmentId, AuthSettingsWriteScope);
  const permissionsId = useId();
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [resumingEnvironmentId] = useState(() =>
    window.desktopBridge ? readPairingSetupResume() : null,
  );
  const [resumed, setResumed] = useState(false);
  const [step, setStep] = useState<"connection" | "permissions">("permissions");
  const [enabledRelay, setEnabledRelay] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [preset, setPreset] = useState<(typeof PERMISSION_PRESETS)[number]["value"]>("standard");
  const [customScopes, setCustomScopes] = useState<ReadonlyArray<AuthGrantScope>>([]);
  const [stage, setStage] = useState<"idle" | "enabling-relay" | "network" | "relay" | "creating">(
    "idle",
  );
  const pending = stage !== "idle";
  const useRelay = relayEnabled || enabledRelay;
  const selectedScopes = (preset === "custom" ? customScopes : PERMISSION_SCOPES[preset]).filter(
    (scope) => delegatableScopes.includes(scope),
  );
  const canCreate =
    selectedScopes.length > 0 && (useRelay ? canPrepareRelay : hasShareableEndpoint);
  const buttonLabel = {
    idle: "Create link",
    "enabling-relay": "Enabling relay…",
    network: "Restarting…",
    relay: "Preparing connection…",
    creating: "Creating link…",
  }[stage];

  if (
    !resumed &&
    !connectionLoading &&
    resumingEnvironmentId !== null &&
    primaryEnvironmentId === resumingEnvironmentId &&
    readPairingSetupResume() === resumingEnvironmentId
  ) {
    setResumed(true);
    setStep(relayEnabled || hasShareableEndpoint ? "permissions" : "connection");
    setOpen(true);
  }

  useEffect(() => {
    if (resumed) clearPairingSetupResume();
  }, [resumed]);

  const enableConnection = async (method: "relay" | "network") => {
    if (pending || primaryEnvironmentId === null) return;
    setConnectionError(null);
    setStage(method === "relay" ? "enabling-relay" : "network");
    try {
      if (method === "network") {
        if (!onEnableNetworkAccess || !(await onEnableNetworkAccess())) {
          throw new Error("Could not enable Network access. Try again or choose Public relay.");
        }
        return;
      }
      if (!readEnvironmentScope(primaryEnvironmentId, AuthSettingsWriteScope)) {
        throw new Error("Ask the host owner to enable Public relay.");
      }
      const updated = await updateSettings({
        environmentId: primaryEnvironmentId,
        input: { patch: { publicRelayEnabled: true } },
      });
      if (updated._tag === "Failure") throw squashAtomCommandFailure(updated);
      setEnabledRelay(true);
      setStep("permissions");
      setStage("idle");
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : "Could not enable the connection. Try again.",
      );
      setStage("idle");
    }
  };

  const createLink = async () => {
    if (
      pending ||
      primaryEnvironmentId === null ||
      selectedScopes.length === 0 ||
      (!useRelay && !hasShareableEndpoint) ||
      !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope) ||
      !selectedScopes.every((scope) => readEnvironmentScope(primaryEnvironmentId, scope))
    )
      return;
    setStage(useRelay ? "relay" : "creating");
    try {
      let relay: RelayConnectionInfo | undefined;
      if (useRelay) {
        const prepared = await prepareRelay({ environmentId: primaryEnvironmentId, input: {} });
        if (prepared._tag === "Failure") throw squashAtomCommandFailure(prepared);
        relay = prepared.value;
      }
      setStage("creating");
      const created = await createServerPairingCredential({ label, scopes: selectedScopes });
      setOpen(false);
      onPairingLinkCreated(created, relay);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create pairing link",
          description: error instanceof Error ? error.message : "Try creating the link again.",
        }),
      );
    } finally {
      setStage("idle");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        if (nextOpen) {
          setLabel("");
          setPreset("standard");
          setCustomScopes([]);
          setEnabledRelay(false);
          setConnectionError(null);
          setStep(relayEnabled || hasShareableEndpoint ? "permissions" : "connection");
        }
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger
        render={
          <Button ref={triggerRef} size="comfortable" disabled={connectionLoading}>
            <PlusIcon aria-hidden />
            Add device
          </Button>
        }
      />
      <DialogPopup
        className="max-w-md"
        showCloseButton={!pending}
        initialFocus={step === "connection" || canCreate ? createButtonRef : undefined}
      >
        {step === "connection" ? (
          <PairingConnectionSetup
            buttonRef={createButtonRef}
            canEnableRelay={canUpdateSettings && canPrepareRelay}
            canEnableNetworkAccess={onEnableNetworkAccess !== undefined}
            stage={stage === "enabling-relay" || stage === "network" ? stage : "idle"}
            error={connectionError}
            onEnable={(method) => void enableConnection(method)}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add a device</DialogTitle>
              <DialogDescription>
                Create a one-time link, then open it on your other device to connect to this
                environment.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <label className="block space-y-2">
                <span className="flex items-baseline gap-2 text-sm font-medium">
                  Device name
                  <span className="text-xs font-normal text-muted-foreground">Optional</span>
                </span>
                <Input
                  autoFocus
                  size="comfortable"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. Living room iPad"
                  disabled={pending}
                />
              </label>
              <div className="space-y-2">
                <label htmlFor={permissionsId} className="block text-sm font-medium">
                  Permissions
                </label>
                <Select
                  items={PERMISSION_PRESETS}
                  value={preset}
                  disabled={pending}
                  onValueChange={(value) => {
                    if (value === null) return;
                    if (value === "custom") setCustomScopes(selectedScopes);
                    setPreset(value);
                  }}
                >
                  <SelectTrigger id={permissionsId} size="comfortable">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {PERMISSION_PRESETS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="min-h-10 text-xs leading-5 text-muted-foreground">
                  {PERMISSION_PRESETS.find((item) => item.value === preset)?.description}
                </p>
              </div>
              {preset === "custom" ? (
                <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-input">
                  {AUTH_SCOPE_OPTIONS.filter(({ scope }) => delegatableScopes.includes(scope)).map(
                    ({ scope, title, description }) => (
                      <label
                        key={scope}
                        className="flex min-h-11 cursor-pointer items-start gap-3 px-3 py-3 transition-colors duration-150 hover:bg-muted/40 has-disabled:cursor-default"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={selectedScopes.includes(scope)}
                          disabled={pending}
                          onCheckedChange={(checked) =>
                            setCustomScopes((current) =>
                              togglePairingScopeSelection(current, scope, checked === true),
                            )
                          }
                        />
                        <span className="min-w-0 space-y-0.5">
                          <span className="block text-xs font-medium">{title}</span>
                          <span className="block text-xs leading-5 text-muted-foreground">
                            {description}
                          </span>
                        </span>
                      </label>
                    ),
                  )}
                </div>
              ) : null}
              <div className="min-h-10 text-xs leading-5" aria-live="polite">
                {!useRelay && !hasShareableEndpoint ? (
                  <Button variant="link" onClick={() => setStep("connection")}>
                    Choose a connection to continue
                  </Button>
                ) : selectedScopes.length === 0 ? (
                  <p className="text-destructive">Select at least one permission to continue.</p>
                ) : selectedScopes.includes(AuthAccessWriteScope) ? (
                  <p className="text-warning">
                    This device can also give or revoke access to other devices.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    You can revoke this device’s access anytime in Authorized clients.
                  </p>
                )}
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                size="comfortable"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                ref={createButtonRef}
                size="comfortable"
                className="w-full sm:w-52"
                disabled={pending || !canCreate}
                aria-busy={pending}
                onClick={() => void createLink()}
              >
                {pending ? <Spinner /> : <LinkIcon aria-hidden />}
                <span aria-live="polite">{buttonLabel}</span>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
