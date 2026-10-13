import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, type Project, type ProjectScript } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectScriptImport from "./ProjectScriptImportService.ts";

const projectId = ProjectId.make("project-import");
const lint: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "vp lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};
const setup = {
  name: "Setup",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: true,
  async: false,
};

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const project: Project = {
    id: projectId,
    title: "Project",
    workspaceRoot: root,
    scripts: [],
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
  const importer = yield* ProjectScriptImport.make.pipe(
    Effect.provide(
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    ),
  );
  const settings = yield* ServerSettings.ServerSettingsService;
  yield* settings.updateSettings({
    projectSettingsOverrides: {
      [projectId]: { defaultProjectScripts: [lint], defaultAutoPull: true },
    },
  });
  return { fs, root, importer, settings };
});

const dependencies = Layer.mergeAll(
  ServerSettings.layerTest({ projectSettingsFolded: true }),
  WorkspaceFileSystem.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({})),
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
  NodeCrypto.layer,
);

it.effect("preserves an import and a concurrent edit to another project setting", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const id = yield* crypto.randomUUIDv4;
    const importing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const editing = yield* Deferred.make<void>();
    const { fs, root, importer, settings } = yield* fixture.pipe(
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Deferred.succeed(importing, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(id),
        ),
      }),
    );
    yield* fs.writeFileString(`${root}/supacode.json`, JSON.stringify({ scripts: [setup] }));
    const importFiber = yield* importer.importFromFile(projectId).pipe(Effect.forkChild);
    yield* Deferred.await(importing);
    const editFiber = yield* Deferred.succeed(editing, undefined).pipe(
      Effect.andThen(
        settings.modifySettings((current) =>
          Effect.succeed({
            projectSettingsOverrides: {
              [projectId]: {
                ...current.projectSettingsOverrides[projectId],
                defaultAutoPull: false,
              },
            },
          }),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(editing);
    yield* Deferred.succeed(release, undefined);
    const scripts = yield* Fiber.join(importFiber);
    yield* Fiber.join(editFiber);
    expect((yield* settings.getSettings).projectSettingsOverrides[projectId]).toMatchObject({
      defaultAutoPull: false,
      defaultProjectScripts: scripts,
    });
  }).pipe(Effect.provide(dependencies)),
);

it.effect("rejects matching commands with different setup options", () =>
  Effect.gen(function* () {
    const { fs, root, importer, settings } = yield* fixture;
    yield* fs.writeFileString(
      `${root}/supacode.json`,
      JSON.stringify({
        scripts: [
          { name: lint.name, command: lint.command, runOnWorktreeCreate: true, async: false },
        ],
      }),
    );
    expect((yield* importer.importFromFile(projectId).pipe(Effect.flip)).message).toContain(
      "different options",
    );
    expect(
      (yield* settings.getSettings).projectSettingsOverrides[projectId]?.defaultProjectScripts,
    ).toEqual([lint]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "imports checked-in scripts into effective project settings and preserves saved actions",
  () =>
    Effect.gen(function* () {
      const { fs, root, importer, settings } = yield* fixture;
      yield* fs.writeFileString(`${root}/supacode.json`, JSON.stringify({ scripts: [setup] }));
      const scripts = yield* importer.importFromFile(projectId);
      expect(scripts).toHaveLength(2);
      expect(scripts[0]).toEqual(lint);
      expect(scripts[1]).toMatchObject(setup);
      const saved = yield* settings.getSettings;
      expect(saved.projectSettingsOverrides[projectId]).toMatchObject({
        defaultProjectScripts: scripts,
        defaultAutoPull: true,
      });
      const repeated = yield* Effect.all(
        [importer.importFromFile(projectId), importer.importFromFile(projectId)],
        { concurrency: 2 },
      );
      expect(repeated).toEqual([scripts, scripts]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect("rejects missing or invalid files without changing saved actions", () =>
  Effect.gen(function* () {
    const { fs, root, importer, settings } = yield* fixture;
    expect((yield* importer.importFromFile(projectId).pipe(Effect.flip))._tag).toBe(
      "ProjectScriptImportError",
    );
    yield* fs.writeFileString(`${root}/supacode.json`, '{"scripts":[{"name":"Broken"}]}');
    expect((yield* importer.importFromFile(projectId).pipe(Effect.flip)).message).toBe(
      "supacode.json is invalid.",
    );
    expect(
      (yield* settings.getSettings).projectSettingsOverrides[projectId]?.defaultProjectScripts,
    ).toEqual([lint]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("rejects conflicting lifecycle actions before importing any scripts", () =>
  Effect.gen(function* () {
    const { fs, root, importer, settings } = yield* fixture;
    yield* fs.writeFileString(
      `${root}/supacode.json`,
      JSON.stringify({ scripts: [setup, { ...setup, command: "different-setup" }] }),
    );
    const error = yield* importer.importFromFile(projectId).pipe(Effect.flip);
    expect(error.message).toContain("already exists");
    expect(
      (yield* settings.getSettings).projectSettingsOverrides[projectId]?.defaultProjectScripts,
    ).toEqual([lint]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("rejects configuration symlinks outside the project", () =>
  Effect.gen(function* () {
    const { fs, root, importer } = yield* fixture;
    const outside = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${outside}/config.json`, JSON.stringify({ scripts: [setup] }));
    yield* fs.symlink(`${outside}/config.json`, `${root}/supacode.json`);
    const error = yield* importer.importFromFile(projectId).pipe(Effect.flip);
    expect(error._tag).toBe("ProjectScriptImportError");
  }).pipe(Effect.provide(dependencies)),
);
