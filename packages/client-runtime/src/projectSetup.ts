import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
} from "@supacode/contracts";

export const PROJECT_SETUP_TITLE = "Set up project script";

export const PROJECT_SETUP_PROMPT = `Set up this repository for Supacode by creating supacode.json at the project root and any supporting setup script it needs.

Inspect the repository instructions, README, manifests, lockfiles, and existing scripts first. Use the project's existing package manager and conventions. Identify the minimum steps a fresh worktree needs, such as installing dependencies, generating code, or making local configuration available. Do not invent commands or add unrelated tooling.

Supacode configuration:
- supacode.json is a JSON or JSONC object at the repository root. Use "$schema": "https://next.supacode.sh/schema/supacode.json".
- "scripts" is an array of objects. Each needs "name" and "command". Optional "icon" values are "play", "test", "lint", "configure", "build", and "debug".
- Mark the setup action with "runOnWorktreeCreate": true and "icon": "configure". Use one setup action; combine multiple steps in a supporting script.
- "async": false makes Supacode wait for setup to finish before starting the agent. Use this when the agent needs the dependencies or generated files. If omitted or true, setup runs alongside the agent.
- "runOnSettle": true runs an action when a thread with its own worktree settles. Add this only if the repository needs cleanup, and keep cleanup inside that worktree.
- Optional "previewUrl" and "autoOpenPreview" configure a script's browser preview. Add them only when the project has a known development server.
- Optional root fields are "iconPath" (a repository-relative image path), "defaultThreadEnvMode" ("local" or "worktree"), and "worktreeSubmodules" ("recursive", "top-level", or "none"). Leave these out unless needed for this task.

Example shape, with a command you must replace with the real setup command:
{
  "$schema": "https://next.supacode.sh/schema/supacode.json",
  "scripts": [
    {
      "name": "Setup worktree",
      "command": "<repository setup command>",
      "icon": "configure",
      "runOnWorktreeCreate": true,
      "async": false
    }
  ]
}

Scripts run in the thread's checkout. SUPACODE_PROJECT_ROOT points to the project's main checkout; SUPACODE_WORKTREE_PATH points to the worktree when one is present; otherwise use the current directory. Quote paths. Make setup safe to repeat and safe when both paths are the same. Preserve existing local files. Never overwrite secrets, commit secret values, or delete the main checkout's files. Reuse an existing local environment file only when the repository expects it, and keep it ignored by Git. Do not start a long-running development server as part of setup.

If supacode.json already exists, read and preserve its unrelated settings and scripts. Validate the configuration and supporting script with the smallest useful checks. Do not run destructive cleanup or a full repository test suite just to validate setup. If no setup is needed, create a valid configuration with an empty scripts array and explain why.

After validation, call the Supacode MCP tool supacode_project_import_scripts with no arguments to import the file's scripts into this thread's project. This preserves saved actions and skips equivalent actions. If the tool is unavailable, denied, or reports conflicting saved actions, explain that the user can import the scripts in Project Settings > Actions; do not edit Supacode's internal settings files or claim activation succeeded.

Finish by summarizing the files changed, what setup runs, whether the agent waits for it, what you verified, and whether the scripts were imported. Leave the changes ready for review; do not commit or push unless the user or repository instructions ask for it.`;

export function projectSetupCommands(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly creationSource: "web" | "mobile";
}) {
  const create = {
    type: "thread.create",
    commandId: CommandId.make(`${input.threadId}:create`),
    createdBy: "user",
    creationSource: input.creationSource,
    threadId: input.threadId,
    projectId: input.projectId,
    title: PROJECT_SETUP_TITLE,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  } as const satisfies OrchestrationV2Command;
  const start = {
    type: "message.dispatch",
    commandId: CommandId.make(`${input.threadId}:start`),
    createdBy: "user",
    creationSource: input.creationSource,
    threadId: input.threadId,
    messageId: MessageId.make(`${input.threadId}:message`),
    text: PROJECT_SETUP_PROMPT,
    attachments: [],
    modelSelection: input.modelSelection,
    dispatchMode: { type: "start_immediately" },
  } as const satisfies OrchestrationV2Command;
  return { create, start };
}
