import type { EnvironmentId, ServerConfig, TailnetStatus } from "@supaterm/contracts";
import { useState } from "react";

import { isLoopbackHostname } from "~/environments/primary";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { TailscaleConfigurationRows } from "./TailscaleConfigurationRows";
import { TailscaleLogo } from "./TailscaleLogo";
import { isTailnetOrigin } from "./TailscaleSettings.logic";
import { TailscaleSignInDialog, type TailscaleSignInSession } from "./TailscaleSignInDialog";
import { TailscaleStatusRows } from "./TailscaleStatusRows";
import { useTailnetOperations } from "./useTailnetOperations";

const LOCKOUT_WARNING = "This page is open over Tailscale and may disconnect.";

export function useTailnetStatus(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.tailnetStatus({ environmentId, input: {} }),
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
        <TailscaleRows environmentId={environmentId} status={status} machineLabel={machineLabel} />
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

function TailscaleRows({
  environmentId,
  status,
  machineLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: TailnetStatus;
  readonly machineLabel: string;
}) {
  const operations = useTailnetOperations(environmentId);
  const [signInSession, setSignInSession] = useState<TailscaleSignInSession | null>(null);
  const lockoutWarning = isTailnetOrigin(window.location.origin, status) ? LOCKOUT_WARNING : null;

  return (
    <>
      <TailscaleStatusRows
        status={status}
        machineLabel={machineLabel}
        lockoutWarning={lockoutWarning}
        operations={operations}
        onSignIn={setSignInSession}
      />
      <TailscaleConfigurationRows
        status={status}
        machineLabel={machineLabel}
        lockoutWarning={lockoutWarning}
        operations={operations}
      />
      {signInSession !== null ? (
        <TailscaleSignInDialog
          status={status}
          machineLabel={machineLabel}
          session={signInSession}
          operations={operations}
          onClose={() => setSignInSession(null)}
        />
      ) : null}
    </>
  );
}
