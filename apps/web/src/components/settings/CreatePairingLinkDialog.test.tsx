// @vitest-environment jsdom

import { AuthGrantScope } from "@supacode/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environmentId: "host-environment",
  permitted: true,
  settingsPermitted: true,
  update: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: {} })),
  prepare: vi.fn(async (_input: unknown) => ({
    _tag: "Success",
    value: {
      relayEndpoint: "https://host.relay.supacode.invalid",
      relayUrl: "wss://relay.supacode.invalid",
    },
  })),
  create: vi.fn(async (_input: unknown) => ({ id: "link", credential: "test-credential" })),
  created: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.permitted }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => state.environmentId }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === "settings:write" ? state.settingsPermitted : state.permitted,
  useEnvironmentScope: () => state.settingsPermitted,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    prepareRelay: { permissionAtom: () => null },
    updateSettings: { permissionAtom: () => null },
  },
}));
vi.mock("~/state/use-atom-command", async () => {
  const { serverEnvironment } = await import("~/state/server");
  return {
    useAtomCommand: (command: unknown) =>
      command === serverEnvironment.prepareRelay ? state.prepare : state.update,
  };
});
vi.mock("~/environments/primary", () => ({ createServerPairingCredential: state.create }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));

import { CreatePairingLinkDialog } from "./CreatePairingLinkDialog";
import { readPairingSetupResume, savePairingSetupResume } from "~/lib/pairingSetupResume";

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof CreatePairingLinkDialog>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  state.environmentId = "host-environment";
  state.permitted = true;
  state.settingsPermitted = true;
  vi.clearAllMocks();
  state.update.mockResolvedValue({ _tag: "Success", value: {} });
  state.prepare.mockResolvedValue({
    _tag: "Success",
    value: {
      relayEndpoint: "https://host.relay.supacode.invalid",
      relayUrl: "wss://relay.supacode.invalid",
    },
  });
  props = {
    triggerRef: { current: null },
    relayEnabled: false,
    hasShareableEndpoint: false,
    connectionLoading: false,
    delegatableScopes: AuthGrantScope.literals,
    onPairingLinkCreated: state.created,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: undefined });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(overrides: Partial<typeof props> = {}) {
  props = { ...props, ...overrides };
  await act(() => root.render(<CreatePairingLinkDialog {...props} />));
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`Button missing: ${label}`);
  return found;
}

async function click(label: string) {
  await act(() => button(label).click());
}

it("cancels connection setup without changing access or minting a token", async () => {
  await render();
  await click("Add device");
  await click("Cancel");
  expect(state.update).not.toHaveBeenCalled();
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});

it("enables relay explicitly and waits for registration before minting a token", async () => {
  await render();
  await click("Add device");
  await click("Enable relay and continue");
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "host-environment",
    input: { patch: { publicRelayEnabled: true } },
  });
  expect(state.create).not.toHaveBeenCalled();

  expect(document.activeElement?.tagName).toBe("INPUT");
  let register: (value: Awaited<ReturnType<typeof state.prepare>>) => void = () => undefined;
  state.prepare.mockReturnValueOnce(
    new Promise((resolve) => {
      register = resolve;
    }),
  );
  await click("Create link");
  expect(state.create).not.toHaveBeenCalled();
  await act(async () => {
    register({
      _tag: "Success",
      value: {
        relayEndpoint: "https://host.relay.supacode.invalid",
        relayUrl: "wss://relay.supacode.invalid",
      },
    });
  });
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(state.created).toHaveBeenCalledWith(
    { id: "link", credential: "test-credential" },
    {
      relayEndpoint: "https://host.relay.supacode.invalid",
      relayUrl: "wss://relay.supacode.invalid",
    },
  );
});

it("keeps setup retryable when enabling relay fails", async () => {
  state.update.mockRejectedValueOnce(new Error("Host settings could not be saved."));
  await render();
  await click("Add device");
  await click("Enable relay and continue");
  expect(document.querySelector("[role=alert]")?.textContent).toContain(
    "Host settings could not be saved.",
  );
  expect(state.create).not.toHaveBeenCalled();
  await click("Enable relay and continue");
  await click("Create link");
  expect(state.create).toHaveBeenCalledTimes(1);
});

it("does not mint a token when relay registration fails", async () => {
  state.prepare.mockRejectedValueOnce(new Error("Relay unavailable."));
  await render({ relayEnabled: true });
  await click("Add device");
  await click("Create link");
  expect(state.create).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Relay unavailable." }),
  );
});

it("preserves an existing direct route without enabling another connection method", async () => {
  await render({ hasShareableEndpoint: true });
  await click("Add device");
  await click("Create link");
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(state.update).not.toHaveBeenCalled();
  expect(state.prepare).not.toHaveBeenCalled();
});

it("blocks token creation if the direct route disappears while the dialog is open", async () => {
  await render({ hasShareableEndpoint: true });
  await click("Add device");
  await render({ hasShareableEndpoint: false });
  await click("Create link");
  expect(state.create).not.toHaveBeenCalled();
  await click("Choose a connection to continue");
  expect(button("Enable relay and continue").disabled).toBe(false);
});

it("checks permission again when enabling relay", async () => {
  await render();
  await click("Add device");
  state.permitted = false;
  state.settingsPermitted = false;
  await click("Enable relay and continue");
  expect(state.update).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});

it("offers network setup when the access manager cannot change relay settings", async () => {
  state.settingsPermitted = false;
  const enableNetwork = vi.fn(async () => true);
  await render({ onEnableNetworkAccess: enableNetwork });
  await click("Add device");
  await click("Restart and enable");
  expect(enableNetwork).toHaveBeenCalledTimes(1);
  expect(state.update).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});

it("does not resume a request that expires while the connection is loading", async () => {
  const now = Date.now();
  savePairingSetupResume("host-environment");
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  await render({ connectionLoading: true });
  vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
  await render({ connectionLoading: false, hasShareableEndpoint: true });
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(state.create).not.toHaveBeenCalled();
});

it("leaves token creation until after a network restart and resumes only for the same host", async () => {
  const enableNetwork = vi.fn(async () => {
    savePairingSetupResume("host-environment");
    return true;
  });
  await render({ onEnableNetworkAccess: enableNetwork });
  await click("Add device");
  const choice = [...document.querySelectorAll("label")].find((label) =>
    label.textContent?.startsWith("Network access"),
  );
  if (!choice) throw new Error("Network choice missing");
  await act(() => choice.click());
  await click("Restart and enable");
  expect(enableNetwork).toHaveBeenCalledTimes(1);
  expect(state.create).not.toHaveBeenCalled();

  await act(() => root.unmount());
  root = createRoot(container);
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  state.environmentId = "another-host";
  await render({ connectionLoading: true, hasShareableEndpoint: true });
  expect(document.querySelector("[role=dialog]")).toBeNull();
  state.environmentId = "host-environment";
  await render();
  expect(document.querySelector("[role=dialog]")).toBeNull();
  await render({ connectionLoading: false });
  expect(readPairingSetupResume()).toBeNull();
  expect(state.create).not.toHaveBeenCalled();
  await click("Create link");
  expect(state.create).toHaveBeenCalledTimes(1);
});

it("allows another connection choice when network setup fails", async () => {
  await render({ onEnableNetworkAccess: async () => false });
  await click("Add device");
  const choice = [...document.querySelectorAll("label")].find((label) =>
    label.textContent?.startsWith("Network access"),
  );
  if (!choice) throw new Error("Network choice missing");
  await act(() => choice.click());
  await click("Restart and enable");
  expect(document.querySelector("[role=alert]")?.textContent).toContain(
    "Try again or choose Public relay.",
  );
  expect(state.create).not.toHaveBeenCalled();
  const relay = [...document.querySelectorAll("label")].find((label) =>
    label.textContent?.startsWith("Public relay"),
  );
  if (!relay) throw new Error("Relay choice missing");
  await act(() => relay.click());
  await click("Enable relay and continue");
  await click("Create link");
  expect(state.create).toHaveBeenCalledTimes(1);
});
