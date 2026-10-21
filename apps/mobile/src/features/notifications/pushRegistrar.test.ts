import { EnvironmentId } from "@supaterm/contracts";
import {
  PushNotificationError,
  type PushRegisterInput,
  type PushRegistrationStatus,
} from "@supaterm/contracts/push";
import type { PushBinding, PushInstallation } from "@supaterm/mobile-push";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import {
  DEFAULT_MOBILE_PUSH_SETTINGS,
  type MobilePushSettings,
} from "../../persistence/mobile-push-store";
import { PushGatewayError, type PushGatewayClient } from "./pushGateway";
import {
  classifyPushHostFailure,
  createPushChallengeMailbox,
  createPushRegistrar,
  type PushEnvironmentState,
  type PushPermission,
  type PushStatusSnapshot,
} from "./pushRegistrar";

const ORIGIN = "https://push.supaterm.com";
const HOST_KEY = "A".repeat(43);
const OTHER_HOST_KEY = "B".repeat(43);
const TOPIC = "com.supaterm.mobile.dev";
const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");

const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

function harness(options: { permission?: PushPermission; token?: string } = {}) {
  let counter = 0;
  const next = () => ++counter;
  const challenges = createPushChallengeMailbox();
  const calls: Array<string> = [];

  const device = {
    permission: options.permission ?? "granted",
    token: options.token ?? "aa11",
    installation: null as PushInstallation | null,
    bindings: new Map<string, PushBinding>(),
    keys: new Set<string>(),
  };
  const gateway = {
    installations: new Map<string, { ownerToken: string; handles: Set<string> }>(),
    down: false,
    pending: new Map<string, { installationId?: string }>(),
  };
  const host = {
    enabled: true,
    hostKey: HOST_KEY,
    origins: [ORIGIN],
    failure: null as unknown,
    registrations: new Map<string, PushRegisterInput & { status: PushRegistrationStatus }>(),
  };
  let stored: MobilePushSettings = DEFAULT_MOBILE_PUSH_SETTINGS;
  const snapshots: PushStatusSnapshot[] = [];

  const ownerCheck = (owner: { installationId: string; ownerToken: string }) => {
    const installation = gateway.installations.get(owner.installationId);
    if (!installation) throw new PushGatewayError({ status: 404, code: "not_found" });
    if (installation.ownerToken !== owner.ownerToken) {
      throw new PushGatewayError({ status: 401, code: "unauthorized" });
    }
    return installation;
  };

  const gatewayClient: PushGatewayClient = {
    origin: ORIGIN,
    enroll: async (_request, owner) => {
      calls.push(owner ? "gateway.enroll(owner)" : "gateway.enroll");
      if (owner) ownerCheck(owner);
      const enrollmentId = `enrollment-${next()}`;
      gateway.pending.set(enrollmentId, owner ? { installationId: owner.installationId } : {});
      queueMicrotask(() => challenges.deliver({ enrollmentId, code: `code-${enrollmentId}` }));
      return { enrollmentId, expiresAt: Date.now() + 600_000 };
    },
    confirm: async (enrollmentId, code) => {
      calls.push("gateway.confirm");
      const pending = gateway.pending.get(enrollmentId);
      if (!pending || code !== `code-${enrollmentId}`) {
        throw new PushGatewayError({ status: 403, code: "invalid_code" });
      }
      if (pending.installationId) return { installationId: pending.installationId };
      const installationId = `installation-${next()}`;
      const ownerToken = `owner-${next()}`;
      gateway.installations.set(installationId, { ownerToken, handles: new Set() });
      return { installationId, ownerToken };
    },
    getInstallation: async (owner) => ({ handles: ownerCheck(owner).handles.size }),
    deleteInstallation: async (owner) => {
      calls.push("gateway.deleteInstallation");
      if (gateway.down) throw new PushGatewayError({ status: 0, code: "network" });
      gateway.installations.delete(owner.installationId);
    },
    createHandle: async (owner) => {
      calls.push("gateway.createHandle");
      const installation = ownerCheck(owner);
      const handle = `${next()}`.padStart(22, "h");
      installation.handles.add(handle);
      return handle;
    },
    deleteHandle: async (owner, handle) => {
      calls.push("gateway.deleteHandle");
      if (gateway.down) throw new PushGatewayError({ status: 0, code: "network" });
      gateway.installations.get(owner.installationId)?.handles.delete(handle);
    },
  };

  const registrar = createPushRegistrar({
    native: {
      configuration: () => ({ supported: true, apnsEnvironment: "sandbox", topic: TOPIC }),
      generateRecipientKey: async () => {
        const keyId = uuid(1000 + next());
        device.keys.add(keyId);
        return { keyId, publicKey: "K".repeat(43) };
      },
      deleteOrphanKeys: async () => {
        const bound = new Set([...device.bindings.values()].map((binding) => binding.keyId));
        for (const keyId of device.keys) if (!bound.has(keyId)) device.keys.delete(keyId);
      },
      saveBinding: async (binding) => {
        device.bindings.set(binding.registrationId, binding);
      },
      deleteBinding: async (registrationId) => {
        const binding = device.bindings.get(registrationId);
        if (binding) device.keys.delete(binding.keyId);
        device.bindings.delete(registrationId);
      },
      listBindings: async () => [...device.bindings.values()],
      getInstallation: async () => device.installation,
      setInstallation: async (installation) => {
        device.installation = installation;
      },
      clearInstallation: async () => {
        device.installation = null;
      },
    },
    gateway: gatewayClient,
    host: {
      describe: async () => {
        calls.push("host.describe");
        if (host.failure) throw host.failure;
        return { enabled: host.enabled, hostKey: host.hostKey, gatewayOrigins: host.origins };
      },
      register: async (_environmentId, input) => {
        calls.push("host.register");
        host.registrations.set(input.registrationId, { ...input, status: "active" });
        return { registrationId: input.registrationId };
      },
      unregister: async (_environmentId, registrationId) => {
        calls.push("host.unregister");
        host.registrations.delete(registrationId);
        return {};
      },
      list: async () => {
        calls.push("host.list");
        return {
          registrations: [...host.registrations.values()].map((registration) => ({
            registrationId: registration.registrationId,
            status: registration.status,
          })),
        } as never;
      },
      test: async (_environmentId, registrationId) => ({
        status: host.registrations.get(registrationId)?.status === "active" ? "accepted" : "gone",
      }),
    },
    permissions: {
      get: async () => device.permission,
      request: async () => {
        calls.push("permissions.request");
        return device.permission;
      },
    },
    deviceToken: async () => device.token,
    store: {
      load: async () => stored,
      save: async (settings) => {
        stored = settings;
      },
    },
    challenges,
    randomId: () => uuid(next()),
    deviceName: "iPhone",
    onStatus: (snapshot) => snapshots.push(snapshot),
  });

  const environments = (connected: ReadonlyArray<EnvironmentId>, saved = connected) => ({
    saved: new Set(saved),
    connected: new Set(connected),
  });

  return {
    registrar,
    device,
    gateway,
    host,
    calls,
    environments,
    stored: () => stored,
    state: (id: EnvironmentId): PushEnvironmentState | undefined =>
      snapshots.at(-1)?.environments.get(id),
    deviceState: () => snapshots.at(-1)?.device,
    clearCalls: () => calls.splice(0),
  };
}

async function enabled(options?: Parameters<typeof harness>[0]) {
  const test = harness(options);
  await test.registrar.sync(test.environments([environmentId]));
  await test.registrar.enable("titles");
  return test;
}

describe("push registrar", () => {
  it("stays off without touching the gateway until the user enables push", async () => {
    const test = harness();
    await test.registrar.sync(test.environments([environmentId]));

    expect(test.state(environmentId)).toEqual({ state: "off" });
    expect(test.calls).toEqual([]);
  });

  it("enrolls the device, answers the challenge, and registers each live environment", async () => {
    const test = await enabled();

    expect(test.calls).toEqual([
      "permissions.request",
      "gateway.enroll",
      "gateway.confirm",
      "host.describe",
      "gateway.createHandle",
      "host.register",
    ]);
    expect(test.device.installation).toMatchObject({ token: "aa11", topic: TOPIC });
    const [registration] = test.stored().registrations;
    expect(registration).toMatchObject({ environmentId, hostKey: HOST_KEY, preview: "titles" });
    expect(test.device.bindings.get(registration!.registrationId)).toEqual({
      registrationId: registration!.registrationId,
      keyId: registration!.keyId,
      environmentId,
      hostKey: HOST_KEY,
    });
    expect(test.host.registrations.get(registration!.registrationId)).toMatchObject({
      gatewayOrigin: ORIGIN,
      handle: registration!.handle,
      recipientKey: { keyId: registration!.keyId },
      preview: "titles",
      deviceName: "iPhone",
    });
    expect(test.state(environmentId)).toEqual({ state: "active", lastDeliveryAt: null });
  });

  it("is idempotent on reconnect", async () => {
    const test = await enabled();
    test.clearCalls();

    await test.registrar.sync(test.environments([environmentId]));

    expect(test.calls).toEqual(["host.describe", "host.list"]);
    expect(test.state(environmentId)).toMatchObject({ state: "active" });
  });

  it("collapses a burst of reconnects into one sync with the latest environments", async () => {
    const test = await enabled();
    test.clearCalls();

    await Promise.all([
      test.registrar.sync(test.environments([], [environmentId])),
      test.registrar.sync(test.environments([environmentId])),
      test.registrar.sync(test.environments([environmentId])),
    ]);

    expect(test.calls).toEqual(["host.describe", "host.list"]);
  });

  it("waits for offline environments and registers them once they connect", async () => {
    const test = harness();
    await test.registrar.sync(test.environments([], [environmentId]));
    await test.registrar.enable("titles");
    expect(test.state(environmentId)).toEqual({ state: "waiting" });
    expect(test.calls).not.toContain("host.describe");

    await test.registrar.sync(test.environments([environmentId]));
    expect(test.state(environmentId)).toMatchObject({ state: "active" });
  });

  it("never asks for permission outside enable, and reports a denial", async () => {
    const test = harness({ permission: "denied" });
    await test.registrar.sync(test.environments([environmentId]));
    await test.registrar.enable("hidden");

    expect(test.deviceState()).toEqual({ state: "permission-denied" });
    expect(test.state(environmentId)).toEqual({ state: "permission-denied" });
    expect(test.calls).toEqual(["permissions.request"]);

    test.clearCalls();
    await test.registrar.sync(test.environments([environmentId]));
    expect(test.calls).toEqual([]);
  });

  it("reports hosts that do not allow the app's gateway", async () => {
    const test = harness();
    test.host.origins = ["https://push.fork.example"];
    await test.registrar.sync(test.environments([environmentId]));
    await test.registrar.enable("titles");

    expect(test.state(environmentId)).toEqual({ state: "origin-not-allowed", origin: ORIGIN });
    expect(test.calls).not.toContain("gateway.createHandle");
  });

  it("reports hosts with push turned off or without push support", async () => {
    const disabled = harness();
    disabled.host.enabled = false;
    await disabled.registrar.sync(disabled.environments([environmentId]));
    await disabled.registrar.enable("titles");
    expect(disabled.state(environmentId)).toEqual({ state: "host-disabled" });

    const old = harness();
    old.host.failure = "Unknown request tag: push.describe";
    await old.registrar.sync(old.environments([environmentId]));
    await old.registrar.enable("titles");
    expect(old.state(environmentId)).toEqual({ state: "host-unsupported" });
  });

  it("rotates the installation's token in place when APNs issues a new one", async () => {
    const test = await enabled();
    const installationId = test.device.installation!.installationId;
    const ownerToken = test.device.installation!.ownerToken;
    test.device.token = "bb22";
    test.clearCalls();

    await test.registrar.sync(test.environments([environmentId]));

    expect(test.calls.slice(0, 2)).toEqual(["gateway.enroll(owner)", "gateway.confirm"]);
    expect(test.device.installation).toMatchObject({ installationId, ownerToken, token: "bb22" });
    expect(test.calls).not.toContain("gateway.createHandle");
  });

  it("enrolls again and re-mints handles when the gateway lost the installation", async () => {
    const test = await enabled();
    const [before] = test.stored().registrations;
    test.gateway.installations.clear();
    test.device.token = "cc33";
    test.clearCalls();

    await test.registrar.sync(test.environments([environmentId]));

    const [after] = test.stored().registrations;
    expect(test.calls.slice(0, 3)).toEqual([
      "gateway.enroll(owner)",
      "gateway.enroll",
      "gateway.confirm",
    ]);
    expect(after!.registrationId).toBe(before!.registrationId);
    expect(after!.installationId).not.toBe(before!.installationId);
    expect(after!.handle).not.toBe(before!.handle);
    expect(test.state(environmentId)).toMatchObject({ state: "active" });
  });

  it("enrolls again when the gateway dropped the installation after an APNs rejection", async () => {
    const test = await enabled();
    const [before] = test.stored().registrations;
    test.gateway.installations.clear();
    test.host.registrations.get(before!.registrationId)!.status = "gone";

    await test.registrar.sync(test.environments([environmentId]));

    const [after] = test.stored().registrations;
    expect(after!.installationId).toBe(test.device.installation!.installationId);
    expect(after!.installationId).not.toBe(before!.installationId);
    expect(test.state(environmentId)).toMatchObject({ state: "active" });
  });

  it("re-mints the handle when the host marked the registration gone", async () => {
    const test = await enabled();
    const [before] = test.stored().registrations;
    test.host.registrations.get(before!.registrationId)!.status = "gone";
    test.clearCalls();

    await test.registrar.sync(test.environments([environmentId]));

    const [after] = test.stored().registrations;
    expect(after!.registrationId).toBe(before!.registrationId);
    expect(after!.keyId).toBe(before!.keyId);
    expect(after!.handle).not.toBe(before!.handle);
    expect(test.calls).toEqual([
      "host.describe",
      "host.list",
      "gateway.createHandle",
      "host.register",
      "gateway.deleteHandle",
    ]);
    expect(test.gateway.installations.get(after!.installationId)!.handles.has(before!.handle)).toBe(
      false,
    );
  });

  it("re-registers when the user changes what to receive", async () => {
    const test = await enabled();
    test.clearCalls();

    await test.registrar.updatePreferences({ preview: "full" });

    const [registration] = test.stored().registrations;
    expect(test.calls).toEqual(["host.describe", "host.list", "host.register"]);
    expect(test.host.registrations.get(registration!.registrationId)?.preview).toBe("full");
    expect(registration!.preview).toBe("full");
  });

  it("replaces the registration when the host's push key changes", async () => {
    const test = await enabled();
    const [before] = test.stored().registrations;
    test.host.hostKey = OTHER_HOST_KEY;

    await test.registrar.sync(test.environments([environmentId]));

    const [after] = test.stored().registrations;
    expect(after!.registrationId).not.toBe(before!.registrationId);
    expect(after!.hostKey).toBe(OTHER_HOST_KEY);
    expect(test.device.bindings.has(before!.registrationId)).toBe(false);
    expect(test.host.registrations.has(before!.registrationId)).toBe(false);
  });

  it("cleans up when an environment is removed", async () => {
    const test = harness();
    await test.registrar.sync(test.environments([environmentId, otherEnvironmentId]));
    await test.registrar.enable("titles");
    expect(test.stored().registrations).toHaveLength(2);
    const removed = test
      .stored()
      .registrations.find((registration) => registration.environmentId === otherEnvironmentId)!;

    await test.registrar.sync(test.environments([environmentId]));

    expect(test.stored().registrations.map((registration) => registration.environmentId)).toEqual([
      environmentId,
    ]);
    expect(test.device.bindings.has(removed.registrationId)).toBe(false);
    expect(
      test.gateway.installations.get(removed.installationId)!.handles.has(removed.handle),
    ).toBe(false);
  });

  it("unregisters from the host before an environment is forgotten", async () => {
    const test = await enabled();
    const [registration] = test.stored().registrations;

    await test.registrar.forgetEnvironment(environmentId);

    expect(test.host.registrations.size).toBe(0);
    expect(test.device.bindings.size).toBe(0);
    expect(test.stored().registrations).toEqual([]);
    expect(test.device.keys.has(registration!.keyId)).toBe(false);
  });

  it("turns everything off and keeps retrying the gateway until it is reachable", async () => {
    const test = await enabled();
    test.gateway.down = true;

    await test.registrar.disable();

    expect(test.stored()).toMatchObject({ enabled: false, registrations: [] });
    expect(test.stored().retiredHandles).toHaveLength(1);
    expect(test.host.registrations.size).toBe(0);
    expect(test.device.bindings.size).toBe(0);
    expect(test.device.installation).not.toBeNull();
    expect(test.state(environmentId)).toEqual({ state: "off" });

    test.gateway.down = false;
    await test.registrar.sync(test.environments([environmentId]));

    expect(test.stored().retiredHandles).toEqual([]);
    expect(test.device.installation).toBeNull();
    expect(test.gateway.installations.size).toBe(0);
  });

  it("deletes the installation when notification permission is revoked", async () => {
    const test = await enabled();
    test.device.permission = "denied";

    await test.registrar.sync(test.environments([environmentId]));

    expect(test.device.installation).toBeNull();
    expect(test.gateway.installations.size).toBe(0);
    expect(test.state(environmentId)).toEqual({ state: "permission-denied" });

    test.device.permission = "granted";
    await test.registrar.sync(test.environments([environmentId]));
    expect(test.state(environmentId)).toMatchObject({ state: "active" });
    const [registration] = test.stored().registrations;
    expect(registration!.installationId).toBe(test.device.installation!.installationId);
  });

  it("re-registers after a test notification finds the registration gone", async () => {
    const test = await enabled();
    const [registration] = test.stored().registrations;
    test.host.registrations.get(registration!.registrationId)!.status = "gone";

    await expect(test.registrar.sendTest(environmentId)).resolves.toBe("gone");
    await expect(test.registrar.sendTest(environmentId)).resolves.toBe("accepted");
  });

  it("removes bindings this device no longer tracks", async () => {
    const test = await enabled();
    test.device.bindings.set(uuid(9999), {
      registrationId: uuid(9999),
      keyId: uuid(9998),
      environmentId: "stale",
      hostKey: HOST_KEY,
    });
    test.device.keys.add(uuid(9998));

    await test.registrar.sync(test.environments([environmentId]));

    expect(test.device.bindings.has(uuid(9999))).toBe(false);
    expect(test.device.keys.has(uuid(9998))).toBe(false);
  });
});

describe("push challenge mailbox", () => {
  it("holds a challenge that arrives before anyone waits for it", async () => {
    const mailbox = createPushChallengeMailbox();
    mailbox.deliver({ enrollmentId: "e1", code: "c1" });
    await expect(mailbox.wait("e1", 1_000)).resolves.toBe("c1");
  });

  it("times out and can be aborted", async () => {
    const mailbox = createPushChallengeMailbox();
    await expect(mailbox.wait("e1", 1)).rejects.toThrow("could not verify");
    const pending = mailbox.wait("e2", 60_000);
    mailbox.abort();
    await expect(pending).rejects.toThrow("could not verify");
  });
});

describe("classifyPushHostFailure", () => {
  it("separates old hosts, typed push errors, and disconnected environments", () => {
    expect(classifyPushHostFailure("Unknown request tag: push.describe")).toBe("unsupported");
    expect(classifyPushHostFailure(new PushNotificationError({ reason: "disabled" }))).toBe(
      "disabled",
    );
    expect(classifyPushHostFailure({ _tag: "EnvironmentRpcUnavailableError" })).toBe("offline");
    expect(classifyPushHostFailure(new Error("boom"))).toBe("error");
  });
});
