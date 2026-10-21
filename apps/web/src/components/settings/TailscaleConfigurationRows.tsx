import type { TailnetConfigureInput, TailnetStatus } from "@supaterm/contracts";
import type { ReactNode } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { TailscaleHostnameRow } from "./TailscaleHostnameRow";
import {
  TAILSCALE_DNS_ADMIN_URL,
  tailnetAddress,
  tailnetConfirmationMessage,
} from "./TailscaleSettings.logic";
import { type TailnetOperations, reportTailnetFailure } from "./useTailnetOperations";

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

export function TailscaleConfigurationRows({
  status,
  machineLabel,
  lockoutWarning,
  operations,
}: {
  readonly status: TailnetStatus;
  readonly machineLabel: string;
  readonly lockoutWarning: string | null;
  readonly operations: TailnetOperations;
}) {
  const { phase, self } = status;
  const pendingPatch = operations.pendingPatch;
  const configurable = operations.available.configure;
  const tagged = self?.tagged === true;
  const effectiveTags = self?.tags ?? status.tags;

  const configure = async (patch: TailnetConfigureInput) => {
    const result = await operations.configure(patch);
    if (result?._tag === "Failure") reportTailnetFailure("Could not update Tailscale", result);
    return result?._tag === "Success";
  };

  const confirmIfServedHere = async (question: string, detail: string) => {
    if (lockoutWarning === null) return true;
    const confirmed = await requestConfirmDialog(
      tailnetConfirmationMessage(question, detail, lockoutWarning),
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
    await configure({ serveEnabled });
  };

  const setRequireOwner = async (requireOwner: boolean) => {
    if (requireOwner) {
      const confirmed = await confirmIfServedHere(
        "Limit access to your Tailscale account?",
        `Only devices signed in as ${self?.loginName ?? "your account"} can connect.`,
      );
      if (!confirmed) return;
    }
    await configure({ requireOwner });
  };

  const setLoggingAllowed = async (loggingAllowed: boolean) => {
    if (!loggingAllowed && status.loggingRequired) {
      const confirmed = await confirmIfServedHere(
        "Turn off Tailscale logging?",
        "Your tailnet requires it, so Tailscale disconnects.",
      );
      if (!confirmed) return;
    }
    await configure({ loggingAllowed });
  };

  return (
    <>
      {phase === "running" ? (
        <>
          <SettingsRow
            title="Serve over Tailscale"
            description={serveDescription(status, machineLabel)}
            status={httpsNote(status)}
            control={
              <Switch
                checked={pendingPatch?.serveEnabled ?? status.serveEnabled}
                disabled={!configurable}
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
                checked={pendingPatch?.requireOwner ?? status.requireOwner}
                disabled={!configurable || (tagged && !status.requireOwner)}
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
          <TailscaleHostnameRow
            hostname={status.hostname ?? status.suggestedHostname}
            dnsName={self?.dnsName}
            lockoutWarning={lockoutWarning}
            disabled={!configurable}
            renaming={pendingPatch?.hostname !== undefined}
            onRename={(hostname) => configure({ hostname })}
          />
        </>
      ) : null}
      {phase !== "unavailable" && status.loggingRequired && !status.loggingAllowed ? (
        <SettingsRow
          title="Your tailnet requires Tailscale logging"
          description="Tailscale won't connect until Supaterm may send its logs to Tailscale."
          control={
            <Button size="sm" disabled={!configurable} onClick={() => void setLoggingAllowed(true)}>
              {pendingPatch?.loggingAllowed === true ? "Allowing…" : "Allow Tailscale logging"}
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
              disabled={!configurable}
              onClick={() => void setLoggingAllowed(false)}
            >
              {pendingPatch?.loggingAllowed === false ? "Turning off…" : "Turn off"}
            </Button>
          }
        />
      ) : null}
    </>
  );
}
