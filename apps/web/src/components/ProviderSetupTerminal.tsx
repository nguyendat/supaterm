import { scopeThreadRef } from "@supaterm/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  ThreadId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
} from "@supaterm/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";
import { terminalEnvironment } from "../state/terminal";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";

interface ProviderSetupTerminalProps {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly command: string;
  readonly terminalLabel: string;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly threadId?: ThreadId;
  readonly onClose: () => void;
}

export function ProviderSetupTerminal({
  environmentId,
  providerInstanceId,
  cwd,
  command,
  terminalLabel,
  keybindings,
  threadId: providedThreadId,
  onClose,
}: ProviderSetupTerminalProps) {
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [threadId] = useState(
    () => providedThreadId ?? ThreadId.make(`provider-setup-${randomUUID()}`),
  );
  const [terminalId] = useState(() => `provider-setup-${randomUUID()}`);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";
  const setupRequest = useMemo(
    () => ({
      attempt: setupAttempt,
      closeTerminal,
      command,
      cwd,
      environmentId,
      openTerminal,
      providerInstanceId,
      terminalId,
      threadId,
      writeTerminal,
    }),
    [
      closeTerminal,
      command,
      cwd,
      environmentId,
      openTerminal,
      providerInstanceId,
      setupAttempt,
      terminalId,
      threadId,
      writeTerminal,
    ],
  );
  const [preparingSetupRequest, setPreparingSetupRequest] = useState(setupRequest);
  if (preparingSetupRequest !== setupRequest) {
    setPreparingSetupRequest(setupRequest);
    setSetupState("preparing");
  }

  useEffect(() => {
    const {
      closeTerminal,
      command,
      cwd,
      environmentId,
      openTerminal,
      providerInstanceId,
      terminalId,
      threadId,
      writeTerminal,
    } = setupRequest;
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
      const opened = await openTerminal({
        environmentId,
        input: { threadId, terminalId, cwd, providerInstanceId },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("writeFailed");
        return;
      }

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId, terminalId, deleteHistory: true },
        });
      });
    };
  }, [setupRequest]);

  return (
    <div
      data-thread-terminal-drawer
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal ? (
            "This connection cannot control terminals."
          ) : setupState === "writeFailed" ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : setupState === "ready" ? (
            "Review the command, then press Enter to run it."
          ) : setupState === "openFailed" ? (
            "Could not open the setup terminal."
          ) : (
            "Preparing command..."
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={threadId}
            terminalId={terminalId}
            terminalLabel={terminalLabel}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}
