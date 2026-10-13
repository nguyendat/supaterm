import { ProjectId, type ProjectScript, SUPACODE_PROJECT_FILE_NAME } from "@supacode/contracts";
import { resolveProjectScripts } from "@supacode/shared/projectScripts";
import { parseSupacodeProjectFile } from "@supacode/shared/supacodeProjectFile";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as ProjectService from "./ProjectService.ts";

export class ProjectScriptImportError extends Schema.TaggedError<ProjectScriptImportError>()(
  "ProjectScriptImportError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isProjectScriptImportError = Schema.is(ProjectScriptImportError);

export class ProjectScriptImportService extends Context.Service<
  ProjectScriptImportService,
  {
    readonly importFromFile: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectScript>, ProjectScriptImportError>;
  }
>()("supacode/project/ProjectScriptImportService") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const crypto = yield* Crypto.Crypto;

  const importFromFile = Effect.fn("ProjectScriptImportService.importFromFile")(
    function* (projectId: ProjectId) {
      const project = yield* projects.getById(projectId);
      if (Option.isNone(project))
        return yield* new ProjectScriptImportError({ message: "The project was not found." });
      const contents = yield* files.readFile({
        cwd: project.value.workspaceRoot,
        relativePath: SUPACODE_PROJECT_FILE_NAME,
      });
      if (contents.truncated)
        return yield* new ProjectScriptImportError({
          message: "supacode.json is too large to import.",
        });
      const file = parseSupacodeProjectFile(contents.contents);
      if (file === null)
        return yield* new ProjectScriptImportError({ message: "supacode.json is invalid." });
      const updated = yield* settings.modifySettings((current) =>
        Effect.gen(function* () {
          const saved = resolveProjectScripts(current, project.value);
          const scripts = [...saved];
          for (const script of file.scripts ?? []) {
            const matching = scripts.find(
              (entry) => entry.name === script.name && entry.command === script.command,
            );
            if (matching) {
              if (
                matching.runOnWorktreeCreate !== (script.runOnWorktreeCreate ?? false) ||
                (matching.runOnSettle ?? false) !== (script.runOnSettle ?? false) ||
                (script.runOnWorktreeCreate &&
                  (matching.async ?? true) !== (script.async ?? true)) ||
                (matching.previewUrl ?? null) !== (script.previewUrl ?? null) ||
                (matching.autoOpenPreview ?? false) !== (script.autoOpenPreview ?? false)
              )
                return yield* new ProjectScriptImportError({
                  message: `The saved action "${script.name}" has different options. Review it in Project Settings > Actions before importing.`,
                });
              continue;
            }
            if (
              (script.runOnWorktreeCreate && scripts.some((entry) => entry.runOnWorktreeCreate)) ||
              (script.runOnSettle && scripts.some((entry) => entry.runOnSettle))
            )
              return yield* new ProjectScriptImportError({
                message:
                  "A different setup or settle action already exists. Review it in Project Settings > Actions before importing another.",
              });
            const id = `script-${(yield* crypto.randomUUIDv4).slice(0, 16)}`;
            scripts.push({
              ...script,
              id,
              icon: script.icon ?? "play",
              runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
            });
          }
          return scripts.length === saved.length
            ? {}
            : {
                projectSettingsOverrides: {
                  [projectId]: {
                    ...current.projectSettingsOverrides[projectId],
                    defaultProjectScripts: scripts,
                  },
                },
              };
        }),
      );
      return resolveProjectScripts(updated, project.value);
    },
    Effect.mapError((cause) =>
      isProjectScriptImportError(cause)
        ? cause
        : new ProjectScriptImportError({
            message: "Could not import supacode.json scripts.",
            cause,
          }),
    ),
  );
  return ProjectScriptImportService.of({ importFromFile });
});

export const layer = Layer.effect(ProjectScriptImportService, make);
