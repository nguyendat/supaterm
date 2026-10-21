import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ServerConfig,
  TailnetConfigureInput,
  TailnetStatus,
} from "@supaterm/contracts";
import { isAtomCommandInterrupted } from "@supaterm/client-runtime/state/runtime";
import type { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { isLoopbackHostname } from "~/environments/primary";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { TailscaleLogo } from "./TailscaleLogo";
import {
  TAILSCALE_DNS_ADMIN_URL,
  isTailnetOrigin,
  secureTailnetAddressFor,
  tailnetAccountSummary,
  tailnetAddress,
  tailnetHostnameError,
  tailnetKeyExpiryDays,
} from "./TailscaleSettings.logic";
import {
  TailscaleSignInDialog,
  type TailscaleSignInSession,
  commandFailureMessage,
  openTailnetLoginUrl,
} from "./TailscaleSignInDialog";

const LOCKOUT_WARNING = "This page is open over Tailscale and may disconnect.";

type StatusHeader = {
  readonly title: string;
  readonly description: string;
  readonly status?: ReactNode;
  readonly control?: ReactNode;
};

export function useTailnetStatus(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.tailnetStatus({ environmentId, input: {} }),
  );
}

function confirmationMessage(question: string, ...details: ReadonlyArray<string | null>) {
  return [question, ...details.filter((detail) => detail !== null)].join("\n");
}

function reportTailnetFailure(title: string, failure: AsyncResult.Failure<unknown, unknown>) {
  if (isAtomCommandInterrupted(failure)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: commandFailureMessage(failure, "Try again."),
    }),
  );
}

function machineLabelFor(
  environmentLabel: string | null,
  serverConfig: Pick<ServerConfig, "environment"> | null,
) {
  const isLocal =
    window.desktopBridge !== undefined || isLoopbackHostname(window.location.hostname);
  if (!isLocal) return environmentLabel ?? "this machine";
  return serverConfig?.environment.platform.os === "darwin" ? "this Mac" : "this machine";
}

function placeholderDescription(canRead: boolean, error: string | null) {
  if (!canRead) return "This connection can't view Tailscale status.";
  if (error !== null) return "Couldn't load Tailscale status.";
  return "Loading…";
}

function keyExpiryWarning(days: number) {
  const unit = days === 1 ? "day" : "days";
  return `This device's Tailscale key expires in ${days} ${unit}. You can turn off key expiry for it in the Tailscale admin console.`;
}

function serveDescription(status: TailnetStatus, machineLabel: string) {
  if (!status.serveEnabled) {
    return `Connect to Supaterm on ${machineLabel} from devices on your tailnet.`;
  }
  return tailnetAddress(status) ?? "Opening the Tailscale address…";
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-info-foreground underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

function httpsNote(status: TailnetStatus): ReactNode {
  if (!status.serveEnabled) return null;
  if (status.https === "disabled") {
    return (
      <span className="block">
        Turn on HTTPS certificates in your{" "}
        <ExternalLink href={TAILSCALE_DNS_ADMIN_URL}>Tailscale admin console</ExternalLink> for a
        secure address.
        {status.httpsMessage ? ` ${status.httpsMessage}` : null}
      </span>
    );
  }
  if (status.httpsMessage) return <span className="block">{status.httpsMessage}</span>;
  if (status.https === "pending" && status.httpsUrl === undefined) {
    return <span className="block">Getting an HTTPS certificate…</span>;
  }
  return null;
}

function hostnameStatus(error: string | null, renaming: boolean): ReactNode {
  if (error !== null) return <span className="block text-destructive">{error}</span>;
  return renaming ? "Renaming…" : null;
}

export function TailscaleSettings({
  environmentId,
  environmentLabel,
  serverConfig,
  canRead,
  status,
  error,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
  readonly canRead: boolean;
  readonly status: TailnetStatus | null;
  readonly error: string | null;
}) {
  const machineLabel = machineLabelFor(environmentLabel, serverConfig);
  return (
    <SettingsSection {...searchableSetting("tailscale")}>
      {status !== null ? (
        <TailscaleStatusRows
          environmentId={environmentId}
          status={status}
          machineLabel={machineLabel}
        />
      ) : (
        <SettingsRow
          icon={<TailscaleLogo />}
          title="Tailscale"
          description={placeholderDescription(canRead, error)}
          status={
            canRead && error !== null ? (
              <span className="block text-destructive">{error}</span>
            ) : null
          }
        />
      )}
    </SettingsSection>
  );
}

function TailscaleStatusRows({
  environmentId,
  status,
  machineLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: TailnetStatus;
  readonly machineLabel: string;
}) {
  const signOut = useAtomCommand(serverEnvironment.tailnetSignOut, { reportFailure: false });
  const cancelSignIn = useAtomCommand(serverEnvironment.tailnetCancelSignIn, {
    reportFailure: false,
  });
  const reauthenticate = useAtomCommand(serverEnvironment.tailnetReauthenticate, {
    reportFailure: false,
  });
  const configure = useAtomCommand(serverEnvironment.tailnetConfigure, { reportFailure: false });
  const canSignIn = useAtomValue(serverEnvironment.tailnetSignIn.permissionAtom(environmentId));
  const canSignOut = useAtomValue(serverEnvironment.tailnetSignOut.permissionAtom(environmentId));
  const canCancelSignIn = useAtomValue(
    serverEnvironment.tailnetCancelSignIn.permissionAtom(environmentId),
  );
  const canReauthenticate = useAtomValue(
    serverEnvironment.tailnetReauthenticate.permissionAtom(environmentId),
  );
  const canConfigure = useAtomValue(
    serverEnvironment.tailnetConfigure.permissionAtom(environmentId),
  );
  const nowMs = useRelativeTimeTick(60 * 60_000);
  const [dialog, setDialog] = useState<TailscaleSignInSession | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "sign-out" | "cancel" | "reauthenticate" | null
  >(null);
  const [pendingPatch, setPendingPatch] = useState<TailnetConfigureInput | null>(null);
  const [hostnameDraft, setHostnameDraft] = useState<string | null>(null);

  const { phase, self } = status;
  const servedHere = isTailnetOrigin(window.location.origin, status);
  const lockoutWarning = servedHere ? LOCKOUT_WARNING : null;
  const busy = pendingAction !== null;
  const configuring = pendingPatch !== null;

  const runConfigure = async (patch: TailnetConfigureInput) => {
    setPendingPatch(patch);
    const result = await configure({ environmentId, input: patch });
    setPendingPatch(null);
    if (result._tag === "Success") return true;
    reportTailnetFailure("Could not update Tailscale", result);
    return false;
  };

  const confirmIfServedHere = async (question: string, detail: string) => {
    if (!servedHere) return true;
    const confirmed = await requestConfirmDialog(
      confirmationMessage(question, detail, LOCKOUT_WARNING),
      { variant: "destructive" },
    );
    return confirmed === true;
  };

  const setServeEnabled = async (serveEnabled: boolean) => {
    if (!serveEnabled) {
      const confirmed = await confirmIfServedHere(
        "Stop serving over Tailscale?",
        "Devices connected over Tailscale lose access.",
      );
      if (!confirmed) return;
    }
    await runConfigure({ serveEnabled });
  };

  const setRequireOwner = async (requireOwner: boolean) => {
    if (requireOwner) {
      const confirmed = await confirmIfServedHere(
        "Limit access to your Tailscale account?",
        `Only devices signed in as ${self?.loginName ?? "your account"} can connect.`,
      );
      if (!confirmed) return;
    }
    await runConfigure({ requireOwner });
  };

  const setLoggingAllowed = async (loggingAllowed: boolean) => {
    if (!loggingAllowed && status.loggingRequired) {
      const confirmed = await confirmIfServedHere(
        "Turn off Tailscale logging?",
        "Your tailnet requires it, so Tailscale disconnects.",
      );
      if (!confirmed) return;
    }
    await runConfigure({ loggingAllowed });
  };

  const signOutOfTailscale = async () => {
    const confirmed = await requestConfirmDialog(
      confirmationMessage(
        "Sign out of Tailscale?",
        "Devices that connect to Supaterm over Tailscale lose access. Your hostname is kept for next time.",
        lockoutWarning,
      ),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setPendingAction("sign-out");
    const result = await signOut({ environmentId, input: {} });
    setPendingAction(null);
    if (result._tag === "Failure") {
      reportTailnetFailure("Could not sign out of Tailscale", result);
      return;
    }
    if (!result.value.remoteLogoutConfirmed) {
      toastManager.add({
        type: "warning",
        title: "Signed out on this machine",
        description:
          "Supaterm couldn't confirm the sign-out with Tailscale, so the device may still be listed in the Tailscale admin console.",
      });
    }
  };

  const cancelEnrollment = async () => {
    setPendingAction("cancel");
    const result = await cancelSignIn({ environmentId, input: {} });
    setPendingAction(null);
    if (result._tag === "Failure") reportTailnetFailure("Could not cancel the sign-in", result);
  };

  const resumeLogin = async (mode: "continue" | "reauthenticate") => {
    setPendingAction("reauthenticate");
    const result = await reauthenticate({ environmentId, input: {} });
    setPendingAction(null);
    if (result._tag === "Failure") {
      reportTailnetFailure("Could not start Tailscale sign-in", result);
      return;
    }
    openTailnetLoginUrl(result.value.loginUrl);
    setDialog({ mode, loginUrl: result.value.loginUrl });
  };

  const currentHostname = status.hostname ?? status.suggestedHostname;
  const hostnameError = hostnameDraft === null ? null : tailnetHostnameError(hostnameDraft.trim());
  const commitHostname = async () => {
    if (hostnameDraft === null) return;
    const hostname = hostnameDraft.trim();
    if (hostname === currentHostname) {
      setHostnameDraft(null);
      return;
    }
    if (tailnetHostnameError(hostname) !== null) return;
    const confirmed = await requestConfirmDialog(
      confirmationMessage(
        `Rename this device to ${hostname}?`,
        "Its Tailscale address may change, and devices paired only by name may need to pair again. The new name is published in public certificate logs.",
        lockoutWarning,
      ),
    );
    if (confirmed !== true) {
      setHostnameDraft(null);
      return;
    }
    if (await runConfigure({ hostname })) setHostnameDraft(null);
  };

  const signOutButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={!canSignOut || busy}
      onClick={() => void signOutOfTailscale()}
    >
      {pendingAction === "sign-out" ? "Signing out…" : "Sign Out…"}
    </Button>
  );
  const cancelEnrollmentButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={!canCancelSignIn || busy}
      onClick={() => void cancelEnrollment()}
    >
      {pendingAction === "cancel" ? "Cancelling…" : "Cancel"}
    </Button>
  );
  const accountSummary = tailnetAccountSummary(self);
  const keyExpiryDays = phase === "running" ? tailnetKeyExpiryDays(self?.keyExpiry, nowMs) : null;

  const header = ((): StatusHeader => {
    switch (phase) {
      case "unavailable":
        return {
          title: "Tailscale is unavailable",
          description: status.message ?? "Built-in Tailscale isn't available on this machine.",
        };
      case "signed-out":
        return {
          title: "Sign in to Tailscale",
          description: "Access Supaterm securely from your other devices.",
          control: (
            <Button size="sm" disabled={!canSignIn} onClick={() => setDialog({ mode: "sign-in" })}>
              Sign In
            </Button>
          ),
        };
      case "starting":
        return {
          title: "Starting Tailscale…",
          description: `Connecting ${machineLabel} to your tailnet.`,
          control: signOutButton,
        };
      case "restarting":
        return {
          title: "Restarting Tailscale…",
          description:
            status.message ?? "Tailscale stopped unexpectedly. Supaterm is starting it again.",
          control: signOutButton,
        };
      case "needs-login":
        return {
          title: "Finish signing in to Tailscale",
          description: status.message ?? `Open the sign-in page to connect ${machineLabel}.`,
          control: (
            <>
              {cancelEnrollmentButton}
              <Button
                size="sm"
                disabled={!canReauthenticate || busy}
                onClick={() => void resumeLogin("continue")}
              >
                {pendingAction === "reauthenticate" ? "Opening…" : "Continue…"}
              </Button>
            </>
          ),
        };
      case "needs-approval":
        return {
          title: "Waiting for approval",
          description: "Waiting for an admin to approve this device",
          control: cancelEnrollmentButton,
        };
      case "needs-reauth":
        return {
          title: "Sign in to Tailscale again",
          description: accountSummary ?? "This device's Tailscale sign-in expired.",
          status: (
            <span className="block text-warning-foreground">
              {status.message ??
                "Supaterm isn't reachable over Tailscale until you reauthenticate."}
            </span>
          ),
          control: (
            <>
              {signOutButton}
              <Button
                size="sm"
                disabled={!canReauthenticate || busy}
                onClick={() => void resumeLogin("reauthenticate")}
              >
                {pendingAction === "reauthenticate" ? "Opening…" : "Reauthenticate"}
              </Button>
            </>
          ),
        };
      case "running":
        return {
          title: "Signed in to Tailscale",
          description: accountSummary ?? "Connected to your tailnet.",
          status:
            keyExpiryDays === null ? null : (
              <span className="block text-warning-foreground">
                {keyExpiryWarning(keyExpiryDays)}
              </span>
            ),
          control: signOutButton,
        };
      case "error":
        return {
          title: "Tailscale stopped",
          description: status.message ?? "Tailscale couldn't start.",
          control: signOutButton,
        };
    }
  })();

  const secureAddress =
    phase === "running"
      ? secureTailnetAddressFor({
          origin: window.location.origin,
          isSecureContext: window.isSecureContext,
          status,
        })
      : null;
  const serveChecked = pendingPatch?.serveEnabled ?? status.serveEnabled;
  const requireOwnerChecked = pendingPatch?.requireOwner ?? status.requireOwner;
  const tagged = self?.tagged === true;
  const effectiveTags = self?.tags ?? status.tags;

  return (
    <>
      <SettingsRow
        icon={<TailscaleLogo />}
        title={header.title}
        description={header.description}
        status={header.status}
        control={header.control}
      />
      {secureAddress !== null ? (
        <SettingsRow
          title="Secure address available"
          description="This page uses plain HTTP, which limits some browser features. You may need to pair this browser again at the HTTPS address."
          control={
            <Button
              size="sm"
              variant="outline"
              render={<a href={secureAddress} rel="noreferrer noopener" />}
            >
              Open HTTPS address
            </Button>
          }
        />
      ) : null}
      {phase === "running" ? (
        <>
          <SettingsRow
            title="Serve over Tailscale"
            description={serveDescription(status, machineLabel)}
            status={httpsNote(status)}
            control={
              <Switch
                checked={serveChecked}
                disabled={!canConfigure || configuring}
                onCheckedChange={(checked) => void setServeEnabled(checked)}
                aria-label="Serve over Tailscale"
              />
            }
          />
          <SettingsRow
            title="Limit access to your Tailscale account"
            description={
              tagged
                ? "Tagged devices follow your tailnet's access policy."
                : `Supaterm will verify the caller is signed in as ${self?.loginName ?? "your Tailscale account"}.`
            }
            status={
              tagged && status.requireOwner ? (
                <span className="block text-warning-foreground">
                  This device became tagged, so access over Tailscale is suspended until you turn
                  this off.
                </span>
              ) : null
            }
            control={
              <Switch
                checked={requireOwnerChecked}
                disabled={!canConfigure || configuring || (tagged && !status.requireOwner)}
                onCheckedChange={(checked) => void setRequireOwner(checked)}
                aria-label="Limit access to your Tailscale account"
              />
            }
          />
          <SettingsRow
            title="Tags"
            description="Sign out and back in to modify tags."
            control={
              <span className="text-sm text-muted-foreground">
                {effectiveTags.length > 0 ? effectiveTags.join(", ") : "None"}
              </span>
            }
          />
          <SettingsRow
            title="Preferred Hostname"
            description={
              self?.dnsName
                ? `Used to generate the Tailscale address, now ${self.dnsName}.`
                : "Used to generate the Tailscale address."
            }
            status={hostnameStatus(hostnameError, pendingPatch?.hostname !== undefined)}
            control={
              <div className="w-full @min-[32rem]/settings-row:w-64">
                <Input
                  size="sm"
                  aria-label="Preferred Hostname"
                  value={hostnameDraft ?? currentHostname}
                  disabled={!canConfigure || configuring}
                  aria-invalid={hostnameError !== null}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setHostnameDraft(event.target.value)}
                  onBlur={() => void commitHostname()}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === "Escape" && hostnameDraft !== null) {
                      event.preventDefault();
                      event.stopPropagation();
                      setHostnameDraft(null);
                    }
                  }}
                />
              </div>
            }
          />
        </>
      ) : null}
      {phase !== "unavailable" && status.loggingRequired && !status.loggingAllowed ? (
        <SettingsRow
          title="Your tailnet requires Tailscale logging"
          description="Tailscale won't connect until Supaterm may send its logs to Tailscale."
          control={
            <Button
              size="sm"
              disabled={!canConfigure || configuring}
              onClick={() => void setLoggingAllowed(true)}
            >
              Allow Tailscale logging
            </Button>
          }
        />
      ) : phase !== "unavailable" && status.loggingAllowed ? (
        <SettingsRow
          title="Tailscale logging"
          description={
            status.loggingRequired
              ? "Supaterm sends Tailscale's logs to Tailscale, as your tailnet requires."
              : "Supaterm sends Tailscale's logs to Tailscale."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!canConfigure || configuring}
              onClick={() => void setLoggingAllowed(false)}
            >
              Turn off
            </Button>
          }
        />
      ) : null}
      {dialog !== null ? (
        <TailscaleSignInDialog
          environmentId={environmentId}
          status={status}
          machineLabel={machineLabel}
          session={dialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
