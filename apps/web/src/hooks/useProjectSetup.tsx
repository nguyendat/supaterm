import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@supacode/client-runtime/environment";
import { PROJECT_SETUP_TITLE } from "@supacode/client-runtime/project-setup";
import {
  SUPACODE_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@supacode/contracts";
import { SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProjectSetupDialog, type ProjectSetupTarget } from "~/components/ProjectSetupDialog";
import { type ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { useProjectEntriesQuery } from "~/components/files/projectFilesQueryState";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useProjectSetupStore } from "~/projectSetupStore";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useWorkspaceMutationRefresh } from "./useWorkspaceMutationRefresh";

export function useProjectSetup(input: {
  environmentId: EnvironmentId;
  project: { id: ProjectId; title: string; workspaceRoot: string } | null;
  runtimeMode: RuntimeMode;
  getModelSelection: () => ModelSelection | null | undefined;
  mutationId?: string | null;
}) {
  const { environmentId, project, runtimeMode, getModelSelection } = input;
  const projectKey = project ? scopedProjectKey({ environmentId, projectId: project.id }) : "";
  const query = useProjectEntriesQuery(
    environmentId,
    project?.workspaceRoot ?? "",
    "",
    project !== null,
  );
  const refresh = query.refresh;
  const canStart = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId, {
      type: "thread.create",
    }),
  );
  const dismissed = useProjectSetupStore((state) => state.dismissed[projectKey] === true);
  const dismiss = useProjectSetupStore((state) => state.dismiss);
  const [target, setTarget] = useState<ProjectSetupTarget | null>(null);
  const missing =
    project !== null &&
    query.error === null &&
    query.data?.truncated === false &&
    !query.data.entries.some((entry) => entry.path === SUPACODE_PROJECT_FILE_NAME);

  useWorkspaceMutationRefresh({
    mutationId: input.mutationId ?? null,
    refresh,
    resourceKey: `project-setup:${projectKey}`,
    enabled: project !== null,
  });
  useEffect(() => {
    if (!project) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [project, refresh]);

  const requestSetup = useCallback(() => {
    const modelSelection = getModelSelection();
    if (!project || !canStart) return;
    if (!modelSelection?.model.trim()) {
      toastManager.add({ type: "error", title: "Choose a model before starting setup." });
      return;
    }
    setTarget({
      environmentId,
      projectId: project.id,
      projectTitle: project.title,
      workspaceRoot: project.workspaceRoot,
      modelSelection,
      runtimeMode,
    });
  }, [canStart, environmentId, getModelSelection, project, runtimeMode]);
  const banner = useMemo<ComposerBannerStackItem | null>(
    () =>
      missing && canStart && !dismissed
        ? {
            id: `project-setup:${projectKey}`,
            variant: "default",
            priority: "notice",
            icon: <SparklesIcon />,
            title: "Let an agent set up this project",
            actions: (
              <Button variant="ghost" size="xs" onClick={requestSetup}>
                {PROJECT_SETUP_TITLE}
              </Button>
            ),
            dismissLabel: "Dismiss project setup suggestion",
            onDismiss: () => dismiss(projectKey),
          }
        : null,
    [canStart, dismiss, dismissed, missing, projectKey, requestSetup],
  );

  return {
    requestSetup: missing && canStart ? requestSetup : undefined,
    banner,
    dialog: target ? <ProjectSetupDialog target={target} onClose={() => setTarget(null)} /> : null,
  };
}
