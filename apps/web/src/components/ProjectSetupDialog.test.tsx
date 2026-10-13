// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@supacode/contracts";
import { PROJECT_SETUP_PROMPT } from "@supacode/client-runtime/project-setup";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), navigate: vi.fn(), allowed: true }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.allowed }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { v2: { dispatchCommand: { permissionAtom: () => null } } },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.dispatch }));
vi.mock("~/state/environments", () => ({ useEnvironment: () => ({ label: "Test environment" }) }));

import { ProjectSetupDialog, type ProjectSetupTarget } from "./ProjectSetupDialog";

const target: ProjectSetupTarget = {
  environmentId: EnvironmentId.make("remote-environment"),
  projectId: ProjectId.make("selected-project"),
  projectTitle: "Example",
  workspaceRoot: "/projects/example",
  modelSelection: { instanceId: ProviderInstanceId.make("custom-provider"), model: "custom-model" },
  runtimeMode: "approval-required",
};
let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
const click = (label: string) => act(async () => button(label).click());

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.allowed = true;
  mocks.dispatch.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.navigate.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ProjectSetupDialog target={target} onClose={onClose} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("creates nothing before confirmation and leaves cancellation local", async () => {
  expect(mocks.dispatch).not.toHaveBeenCalled();
  await click("Cancel");
  expect(onClose).toHaveBeenCalledOnce();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("starts a separate root thread with the chosen model and full prompt", async () => {
  await click("Start setup thread");
  const [creation, message] = mocks.dispatch.mock.calls.map(([request]) => request);
  expect(creation).toMatchObject({
    environmentId: target.environmentId,
    input: {
      type: "thread.create",
      projectId: target.projectId,
      modelSelection: target.modelSelection,
      runtimeMode: target.runtimeMode,
      interactionMode: "default",
      worktreePath: null,
    },
  });
  expect(message).toMatchObject({
    environmentId: target.environmentId,
    input: {
      type: "message.dispatch",
      threadId: creation.input.threadId,
      text: PROJECT_SETUP_PROMPT,
    },
  });
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: target.environmentId, threadId: creation.input.threadId },
  });
});

it("reuses command and thread IDs when retrying after an uncertain send", async () => {
  mocks.dispatch
    .mockResolvedValueOnce({ _tag: "Success" })
    .mockRejectedValueOnce(new Error("Connection lost"));
  await click("Start setup thread");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
  expect(mocks.navigate).not.toHaveBeenCalled();
  await click("Retry setup thread");
  expect(mocks.dispatch.mock.calls[2]).toEqual(mocks.dispatch.mock.calls[0]);
  expect(mocks.dispatch.mock.calls[3]).toEqual(mocks.dispatch.mock.calls[1]);
});

it("ignores repeat confirmation while the first command is pending", async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.dispatch.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    const start = button("Start setup thread");
    start.click();
    start.click();
  });
  expect(mocks.dispatch).toHaveBeenCalledOnce();
  await act(async () => finish({ _tag: "Success" }));
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
});

it("prevents launch if the destination grant is revoked", async () => {
  mocks.allowed = false;
  await act(async () => root.render(<ProjectSetupDialog target={target} onClose={onClose} />));
  await click("Start setup thread");
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
