import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TailnetStatus } from "@supaterm/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@supaterm/client-runtime/state/runtime";
import type { AsyncResult } from "effect/reactivity";
import { useEffect, useId, useRef, useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { TailscaleLogo } from "./TailscaleLogo";
import { parseTailnetTagsInput, tailnetHostnameError } from "./TailscaleSettings.logic";

export type TailscaleSignInSession =
  | { readonly mode: "sign-in" }
  | { readonly mode: "continue" | "reauthenticate"; readonly loginUrl: string | null };

function httpsUrlOrNull(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function openTailnetLoginUrl(url: string | null) {
  const safeUrl = httpsUrlOrNull(url);
  if (safeUrl === null) return;
  const bridge = window.desktopBridge;
  if (bridge) {
    void settlePromise(() => bridge.openExternal(safeUrl));
    return;
  }
  window.open(safeUrl, "_blank", "noopener");
}

export function commandFailureMessage(
  failure: AsyncResult.Failure<unknown, unknown>,
  fallback: string,
): string {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function TailscaleSignInDialog({
  environmentId,
  status,
  machineLabel,
  session,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: TailnetStatus;
  readonly machineLabel: string;
  readonly session: TailscaleSignInSession;
  readonly onClose: () => void;
}) {
  const signIn = useAtomCommand(serverEnvironment.tailnetSignIn, { reportFailure: false });
  const cancelSignIn = useAtomCommand(serverEnvironment.tailnetCancelSignIn, {
    reportFailure: false,
  });
  const canSignIn = useAtomValue(serverEnvironment.tailnetSignIn.permissionAtom(environmentId));
  const hostnameId = useId();
  const tagsId = useId();
  const hostnameRef = useRef<HTMLInputElement>(null);
  const [hostname, setHostname] = useState(status.hostname ?? status.suggestedHostname);
  const [tagsInput, setTagsInput] = useState(status.tags.join(", "));
  const [stage, setStage] = useState<"form" | "waiting">(
    session.mode === "sign-in" ? "form" : "waiting",
  );
  const [loginUrl, setLoginUrl] = useState(
    session.mode === "sign-in" ? null : httpsUrlOrNull(session.loginUrl),
  );
  const [focusTags, setFocusTags] = useState(false);
  const [pending, setPending] = useState<"sign-in" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrollmentStarted, setEnrollmentStarted] = useState(session.mode === "continue");
  const reauthenticating = session.mode === "reauthenticate";
  const trimmedHostname = hostname.trim();
  const hostnameError = tailnetHostnameError(trimmedHostname);
  const tags = parseTailnetTagsInput(tagsInput);
  const canSubmit =
    canSignIn && pending === null && hostnameError === null && tags.invalid.length === 0;

  useEffect(() => {
    if (stage === "waiting" && status.phase === "running") onClose();
  }, [stage, status.phase, onClose]);

  const resetEnrollment = async () => {
    const result = await cancelSignIn({ environmentId, input: {} });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
    return commandFailureMessage(result, "Could not cancel the sign-in.");
  };

  const submit = async () => {
    if (stage !== "form" || !canSubmit) return;
    setPending("sign-in");
    setError(null);
    // A rejected or abandoned attempt can leave the node enrolled with the old tags.
    if (enrollmentStarted) await resetEnrollment();
    setEnrollmentStarted(true);
    const result = await signIn({
      environmentId,
      input: { hostname: trimmedHostname, tags: tags.tags },
    });
    setPending(null);
    if (result._tag === "Success") {
      const url = httpsUrlOrNull(result.value.loginUrl);
      setLoginUrl(url);
      setStage("waiting");
      openTailnetLoginUrl(url);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setError(commandFailureMessage(result, "Could not start Tailscale sign-in."));
  };

  const waitingError = stage === "waiting" ? (status.message ?? error) : null;
  const awaitingApproval = stage === "waiting" && status.phase === "needs-approval";
  const stopped =
    stage === "waiting" &&
    waitingError === null &&
    (status.phase === "signed-out" || status.phase === "unavailable");
  const closesWhen = reauthenticating
    ? `${machineLabel} reconnects`
    : `${machineLabel} joins your tailnet`;
  const description =
    stage === "form"
      ? `Choose a hostname and optional tags for ${machineLabel}.`
      : `Finish signing in from your browser. This closes when ${closesWhen}.`;
  const dismissLabel = stopped ? "Close" : "Cancel";

  const cancel = async () => {
    if (pending === "cancel") return;
    if (!reauthenticating && !stopped && (enrollmentStarted || stage === "waiting")) {
      setPending("cancel");
      const failure = await resetEnrollment();
      setPending(null);
      if (failure !== null) {
        setError(failure);
        return;
      }
    }
    onClose();
  };

  const editTags = () => {
    setError(null);
    setFocusTags(true);
    setStage("form");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void cancel();
      }}
    >
      <DialogPopup
        className="max-w-lg"
        initialFocus={stage === "form" ? hostnameRef : undefined}
        showCloseButton={pending !== "cancel"}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          />
        }
      >
        <DialogHeader>
          <div className="flex items-center gap-4">
            <TailscaleLogo size="lg" />
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>
                {reauthenticating ? "Sign in to Tailscale again" : "Sign in to Tailscale"}
              </DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel>
          {stage === "form" ? (
            <>
              {error ? (
                <Alert variant="error" role="status">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <div className="space-y-2">
                <label htmlFor={hostnameId} className="block text-sm font-medium">
                  Preferred Hostname
                </label>
                <Input
                  ref={hostnameRef}
                  id={hostnameId}
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                  disabled={pending !== null}
                  aria-invalid={hostnameError !== null}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  {hostnameError ??
                    "Used to generate the Tailscale address. It appears in public certificate logs when HTTPS is on."}
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor={tagsId} className="block text-sm font-medium">
                  Tags
                </label>
                <Input
                  id={tagsId}
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.target.value)}
                  placeholder="tag:name"
                  disabled={pending !== null}
                  aria-invalid={tags.invalid.length > 0}
                  autoFocus={focusTags}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  {tags.invalid.length > 0
                    ? `Tags look like tag:name and start with a letter. Check ${tags.invalid.join(", ")}.`
                    : "Optional. Run as a tagged device so your tailnet's policy decides who can connect."}
                </p>
              </div>
            </>
          ) : (
            <>
              {waitingError ? (
                <Alert variant="error" role="status">
                  <AlertDescription>{waitingError}</AlertDescription>
                  {reauthenticating ? null : (
                    <AlertAction>
                      <Button size="xs" variant="outline" onClick={editTags}>
                        Edit tags
                      </Button>
                    </AlertAction>
                  )}
                </Alert>
              ) : stopped ? (
                <Alert variant="error" role="status">
                  <AlertDescription>
                    Sign-in stopped. Close this and sign in again.
                  </AlertDescription>
                </Alert>
              ) : (
                <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                  {awaitingApproval
                    ? "Waiting for an admin to approve this device"
                    : "Waiting for Tailscale…"}
                </p>
              )}
              {loginUrl !== null && !awaitingApproval ? (
                <figure className="flex flex-col items-center gap-3">
                  <div className="rounded-xl bg-white p-3">
                    <QRCodeSvg
                      value={loginUrl}
                      size={168}
                      level="M"
                      marginSize={1}
                      title="Tailscale sign-in link"
                    />
                  </div>
                  <figcaption className="max-w-full space-y-1 text-center text-xs text-muted-foreground">
                    <span className="block">Scan to sign in on another device, or open</span>
                    <a
                      href={loginUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block break-all text-info-foreground underline-offset-2 hover:underline"
                    >
                      {loginUrl}
                    </a>
                  </figcaption>
                </figure>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending === "cancel"} onClick={() => void cancel()}>
            {pending === "cancel" ? "Cancelling…" : dismissLabel}
          </Button>
          {stage === "form" ? (
            <Button type="submit" disabled={!canSubmit}>
              {pending === "sign-in" ? "Starting…" : "Sign In"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
