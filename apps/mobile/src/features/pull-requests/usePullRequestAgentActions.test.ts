import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PullRequestDetail } from "@supaterm/contracts";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";

const state = vi.hoisted(() => ({
  connected: false,
  canAsk: true,
  threadsKnown: false,
  ask: vi.fn(),
}));
vi.mock("./usePullRequestConnected", () => ({
  usePullRequestConnected: () => state.connected,
}));
vi.mock("./usePullRequestThreads", () => ({
  usePullRequestThreads: () => ({
    threads: [],
    canAsk: state.canAsk,
    canWatch: true,
    busy: false,
    isPending: true,
    threadsKnown: state.threadsKnown,
    ask: state.ask,
  }),
}));
const params = {
  environmentId: "environment",
  projectId: "project",
  repository: "owner/repo",
  number: 1,
};
const pr = { state: "open", mergeability: "conflicting" } as PullRequestDetail;

beforeEach(() => {
  state.connected = false;
  state.canAsk = true;
  state.threadsKnown = false;
  state.ask.mockClear();
});

describe("PR agent drafts", () => {
  it("opens offline drafts without waiting for linked-thread discovery", () => {
    const actions = usePullRequestAgentActions(params, pr);
    expect(actions.disabled).toBe(false);
    actions.start("ask");
    actions.start("explain");
    expect(state.ask.mock.calls).toEqual([
      [undefined, "ask"],
      [undefined, "explain"],
    ]);
  });

  it("does not open drafts when the connection denies task access", () => {
    state.connected = true;
    state.canAsk = false;
    usePullRequestAgentActions(params, pr).start("explain");
    expect(state.ask).not.toHaveBeenCalled();
  });

  it("waits for the first linked-thread lookup but not for later refreshes", () => {
    state.connected = true;
    expect(usePullRequestAgentActions(params, pr).disabled).toBe(true);
    state.threadsKnown = true;
    const actions = usePullRequestAgentActions(params, pr);
    expect(actions.disabled).toBe(false);
    actions.start("explain");
    expect(state.ask.mock.calls).toEqual([[undefined, "explain"]]);
  });
});
