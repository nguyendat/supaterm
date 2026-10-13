import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  projectSetupCommands,
  PROJECT_SETUP_PROMPT,
  PROJECT_SETUP_TITLE,
} from "@supacode/client-runtime/project-setup";
import { squashAtomCommandFailure } from "@supacode/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@supacode/contracts";
import { useEnvironment } from "~/state/environments";
import { formatModelSlugName } from "@supacode/shared/model";
import { newThreadId } from "~/lib/utils";
import { SparklesIcon } from "lucide-react";
import { useRef, useState } from "react";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface ProjectSetupTarget {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectTitle: string;
  workspaceRoot: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
}

export function ProjectSetupDialog({
  target,
  onClose,
}: {
  target: ProjectSetupTarget;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(target.environmentId);
  const [commands] = useState(() =>
    projectSetupCommands({
      ...target,
      threadId: newThreadId(),
      creationSource: "web",
    }),
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const allowed = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(
      target.environmentId,
      commands.create,
    ),
  );
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openThread = () =>
    navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: target.environmentId, threadId: commands.create.threadId },
    });
  const start = async () => {
    if (busyRef.current || !allowed) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      for (const command of [commands.create, commands.start]) {
        const result = await dispatch({ environmentId: target.environmentId, input: command });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (command === commands.create) setCreated(true);
      }
      await openThread();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the setup thread.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busyRef.current) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{PROJECT_SETUP_TITLE}</DialogTitle>
          <DialogDescription>
            Start a new thread to inspect {target.projectTitle}, create supacode.json and any
            supporting setup script, and import its actions into Supacode.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4 text-sm">
            <p>
              The agent will work in the main checkout. You can follow its progress and review the
              changes in the new thread. Your current draft stays here.
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">Project</dt>
              <dd>{target.projectTitle}</dd>
              <dt className="text-muted-foreground">Environment</dt>
              <dd>{environment?.label ?? target.environmentId}</dd>
              <dt className="text-muted-foreground">Agent</dt>
              <dd>{target.modelSelection.instanceId}</dd>
              <dt className="text-muted-foreground">Model</dt>
              <dd>{formatModelSlugName(target.modelSelection.model)}</dd>
              <dt className="text-muted-foreground">Checkout</dt>
              <dd className="break-all font-mono text-xs">{target.workspaceRoot}</dd>
            </dl>
            <details>
              <summary className="cursor-pointer text-muted-foreground">View setup prompt</summary>
              <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-xs">
                {PROJECT_SETUP_PROMPT}
              </pre>
            </details>
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
            {!allowed ? (
              <p role="alert">This connection needs permission to start threads.</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {created && error ? (
            <Button variant="ghost" disabled={busy} onClick={() => void openThread().then(onClose)}>
              Open thread
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!allowed || busy} onClick={() => void start()}>
            <SparklesIcon />
            {busy ? "Starting…" : error ? "Retry setup thread" : "Start setup thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
