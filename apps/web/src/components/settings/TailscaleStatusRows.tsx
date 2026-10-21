import type { TailnetStatus } from "@supaterm/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, useRelativeTimeTick } from "./settingsLayout";
import { TailscaleLogo } from "./TailscaleLogo";
import {
  type TailnetAccountAction,
  secureTailnetAddressFor,
  tailnetConfirmationMessage,
  tailnetStatusHeader,
} from "./TailscaleSettings.logic";
import { type TailscaleSignInSession, openTailnetLoginUrl } from "./TailscaleSignInDialog";
import { type TailnetOperations, reportTailnetFailure } from "./useTailnetOperations";

export function TailscaleStatusRows({
  status,
  machineLabel,
  lockoutWarning,
  operations,
  onSignIn,
}: {
  readonly status: TailnetStatus;
  readonly machineLabel: string;
  readonly lockoutWarning: string | null;
  readonly operations: TailnetOperations;
  readonly onSignIn: (session: TailscaleSignInSession) => void;
}) {
  const nowMs = useRelativeTimeTick(60 * 60_000);
  const header = tailnetStatusHeader(status, machineLabel, nowMs);
  const pending = operations.active?.kind;
  const secureAddress =
    status.phase === "running"
      ? secureTailnetAddressFor({
          origin: window.location.origin,
          isSecureContext: window.isSecureContext,
          status,
        })
      : null;

  const signOut = async () => {
    const confirmed = await requestConfirmDialog(
      tailnetConfirmationMessage(
        "Sign out of Tailscale?",
        "Devices that connect to Supaterm over Tailscale lose access. Your hostname is kept for next time.",
        lockoutWarning,
      ),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const result = await operations.signOut();
    if (result === null) return;
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
    const result = await operations.cancelSignIn();
    if (result?._tag === "Failure") reportTailnetFailure("Could not cancel the sign-in", result);
  };

  const resumeLogin = async (mode: "continue" | "reauthenticate") => {
    const result = await operations.reauthenticate();
    if (result === null) return;
    if (result._tag === "Failure") {
      reportTailnetFailure("Could not start Tailscale sign-in", result);
      return;
    }
    openTailnetLoginUrl(result.value.loginUrl);
    onSignIn({ mode, loginUrl: result.value.loginUrl });
  };

  const actionButton = (action: TailnetAccountAction) => {
    switch (action) {
      case "sign-in":
        return (
          <Button
            key={action}
            size="sm"
            disabled={!operations.available["sign-in"]}
            onClick={() => onSignIn({ mode: "sign-in" })}
          >
            Sign In
          </Button>
        );
      case "sign-out":
        return (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={!operations.available["sign-out"]}
            onClick={() => void signOut()}
          >
            {pending === "sign-out" ? "Signing out…" : "Sign Out…"}
          </Button>
        );
      case "cancel-sign-in":
        return (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={!operations.available["cancel-sign-in"]}
            onClick={() => void cancelEnrollment()}
          >
            {pending === "cancel-sign-in" ? "Cancelling…" : "Cancel"}
          </Button>
        );
      case "continue":
      case "reauthenticate":
        return (
          <Button
            key={action}
            size="sm"
            disabled={!operations.available.reauthenticate}
            onClick={() => void resumeLogin(action)}
          >
            {pending === "reauthenticate"
              ? "Opening…"
              : action === "continue"
                ? "Continue…"
                : "Reauthenticate"}
          </Button>
        );
    }
  };

  return (
    <>
      <SettingsRow
        icon={<TailscaleLogo />}
        title={header.title}
        description={header.description}
        status={
          header.warning === undefined ? null : (
            <span className="block text-warning-foreground">{header.warning}</span>
          )
        }
        control={header.actions.length > 0 ? header.actions.map(actionButton) : null}
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
    </>
  );
}
