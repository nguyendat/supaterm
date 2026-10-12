import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@supacode/contracts";
import {
  DEFAULT_PUSH_PREFERENCES,
  PushNotificationError,
  type PushRegistration,
} from "@supacode/contracts/push";
import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), token: vi.fn(), direct: vi.fn() }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "3369f9f0-77a8-46db-8ab5-c36f3d689563" }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-application", () => ({
  applicationId: "com.supaterm.supacode",
  getIosPushNotificationServiceEnvironmentAsync: async () => "development",
}));
vi.mock("expo-notifications", () => ({
  IosAuthorizationStatus: { PROVISIONAL: 3, EPHEMERAL: 4 },
  getPermissionsAsync: async () => ({ granted: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  getDevicePushTokenAsync: mocks.token,
}));
vi.mock("../../state/push", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    pushCommands: {
      state: "state",
      register: "register",
      confirm: "confirm",
      preferences: "preferences",
      revoke: "revoke",
    },
    runPushCommand: mocks.rpc,
    pushRegistrationAtom: Atom.family(() => Atom.make({ registration: null, status: "loading" })),
  };
});
vi.mock("../../lib/runtime", async () => {
  const NodeCrypto = await import("node:crypto");
  const Crypto = await import("effect/Crypto");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const ManagedRuntime = await import("effect/ManagedRuntime");
  const Push = await import("../../persistence/mobile-push-store");
  const Storage = await import("../../persistence/mobile-storage");
  const Secure = await import("../../persistence/mobile-secure-storage");
  const values = new Map<string, string>();
  const storage = Layer.succeed(Secure.MobileSecureStorage, {
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
  const crypto = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
      digest: (algorithm, data) =>
        Effect.sync(
          () =>
            new Uint8Array(
              NodeCrypto.createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest(),
            ),
        ),
    }),
  );
  const layer = Layer.mergeAll(Push.layer, Storage.layer).pipe(
    Layer.provideMerge(storage),
    Layer.provideMerge(crypto),
  );
  // oxlint-disable-next-line supacode/no-manual-effect-runtime-in-tests -- Native lifecycle helpers use the app promise runtime; this fixture exercises that boundary and its persistent state.
  return { runtime: ManagedRuntime.make(layer) };
});
import { runtime } from "../../lib/runtime";
import * as MobilePushStore from "../../persistence/mobile-push-store";
import {
  disablePushRegistration,
  enablePushRegistration,
  loadPushRecord,
  refreshPushRegistration,
  saveEnrollmentChallenge,
  updatePushPreferences,
} from "./pushRegistration";

const preferences = { ...DEFAULT_PUSH_PREFERENCES, enabled: true };
let host: PushRegistration;
const initial = (): PushRegistration => ({
  recipientId: "ddb9b169-4492-4845-82e4-34a728c92877",
  generation: 1,
  status: "active",
  preferences,
  gatewayUrl: "https://push.supacode.sh",
});
function gate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function seed(environmentId: EnvironmentId) {
  await runtime.runPromise(
    MobilePushStore.MobilePushStore.pipe(
      Effect.flatMap((store) => store.ensure(environmentId)),
      Effect.flatMap((record) =>
        MobilePushStore.MobilePushStore.pipe(
          Effect.flatMap((store) => store.save({ ...record, registration: host, preferences })),
        ),
      ),
    ),
  );
}
beforeEach(() => {
  host = initial();
  mocks.rpc.mockReset();
  mocks.token.mockReset();
  mocks.direct.mockReset();
  mocks.token.mockResolvedValue({ type: "ios", data: "ab".repeat(32) });
  mocks.direct.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", mocks.direct);
  mocks.rpc.mockImplementation(async (command, _environmentId, input) => {
    switch (command) {
      case "state":
        return { gatewayUrl: host.gatewayUrl, registration: host };
      case "register":
        host = {
          ...host,
          generation: host.status === "revoked" ? host.generation + 1 : host.generation,
          status: "active",
          preferences: input.preferences,
        };
        return host;
      case "confirm":
        host = { ...host, status: "active" };
        return host;
      case "preferences":
        host = { ...host, preferences: input.preferences };
        return host;
      case "revoke":
        host = { ...host, status: "revoked", preferences: { ...host.preferences, enabled: false } };
        return undefined;
    }
    throw new Error("Unexpected command");
  });
});

it("serializes a foreground refresh with disable and later preference changes", async () => {
  const environmentId = EnvironmentId.make("lifecycle-race");
  await seed(environmentId);
  const started = gate<void>();
  const token = gate<{ type: string; data: string }>();
  mocks.token.mockImplementationOnce(() => {
    started.resolve();
    return token.promise;
  });
  const refreshing = refreshPushRegistration(environmentId);
  await started.promise;
  const disable = disablePushRegistration(environmentId);
  const update = updatePushPreferences(environmentId, { completion: false });
  token.resolve({ type: "ios", data: "ab".repeat(32) });
  await Promise.all([refreshing, disable, update]);
  const record = await loadPushRecord(environmentId);
  expect(record?.preferences).toMatchObject({ enabled: false, completion: false });
  expect(host.status).toBe("revoked");
  expect(host.preferences.enabled).toBe(false);
});

it("holds re-enable behind both revocations and rotates the secret for the new enrollment", async () => {
  const environmentId = EnvironmentId.make("delayed-revocation");
  await seed(environmentId);
  const prior = await loadPushRecord(environmentId);
  const directStarted = gate<void>();
  const direct = gate<{ ok: boolean }>();
  mocks.direct.mockImplementationOnce(() => {
    directStarted.resolve();
    return direct.promise;
  });
  const disable = disablePushRegistration(environmentId);
  await directStarted.promise;
  const enabling = enablePushRegistration(environmentId);
  expect(mocks.rpc.mock.calls.filter(([command]) => command === "register")).toHaveLength(0);
  direct.resolve({ ok: true });
  await Promise.all([disable, enabling]);
  const input = mocks.rpc.mock.calls.find(([command]) => command === "register")?.[2];
  expect(input.revocationToken).not.toBe(prior?.revocationToken);
  expect(input.previousRevocationToken).toBe(prior?.revocationToken);
  expect((await loadPushRecord(environmentId))?.previousRevocationToken).toBeUndefined();
  expect(host.status).toBe("active");
  expect(host.generation).toBe(2);
});

it("reconciles direct revocation before enabling after the host reconnects", async () => {
  const environmentId = EnvironmentId.make("offline-revocation");
  await seed(environmentId);
  const defaultRpc = mocks.rpc.getMockImplementation();
  mocks.rpc.mockImplementation(async (command, environmentId, input) => {
    if (command === "revoke") throw new Error("Host offline");
    return defaultRpc?.(command, environmentId, input);
  });
  await disablePushRegistration(environmentId);
  expect((await loadPushRecord(environmentId))?.revocationPending).toBe(true);
  if (defaultRpc === undefined) throw new Error("RPC fixture missing");
  mocks.rpc.mockImplementation(defaultRpc);
  await refreshPushRegistration(environmentId);
  expect((await loadPushRecord(environmentId))?.preferences.enabled).toBe(false);
  expect(host.status).toBe("revoked");
  await enablePushRegistration(environmentId);
  expect(host.status).toBe("active");
  expect(host.generation).toBe(2);
});

it("confirms the current challenge when APNs delivers an older rotation last", async () => {
  const environmentId = EnvironmentId.make("challenge-rotation");
  host = { ...host, status: "pending" };
  await seed(environmentId);
  const current = {
    version: 1 as const,
    recipientId: host.recipientId,
    generation: 1,
    challenge: "a".repeat(43),
  };
  const stale = { ...current, challenge: "b".repeat(43) };
  await saveEnrollmentChallenge(current);
  await saveEnrollmentChallenge(stale);
  const defaultRpc = mocks.rpc.getMockImplementation();
  mocks.rpc.mockImplementation(async (command, environmentId, input) => {
    if (command === "confirm" && input.challenge !== current.challenge)
      throw new PushNotificationError({ operation: "confirm", reason: "rejected" });
    return defaultRpc?.(command, environmentId, input);
  });
  await refreshPushRegistration(environmentId);
  expect(host.status).toBe("active");
  expect(mocks.rpc.mock.calls.filter(([command]) => command === "confirm")).toHaveLength(2);
});

it("reconciles a cached revocation when re-pairing creates a new session", async () => {
  const environmentId = EnvironmentId.make("repaired-revocation");
  await seed(environmentId);
  const prior = await loadPushRecord(environmentId);
  const defaultRpc = mocks.rpc.getMockImplementation();
  mocks.rpc.mockImplementation(async (command, environmentId, input) => {
    if (command === "revoke") throw new Error("Host offline");
    return defaultRpc?.(command, environmentId, input);
  });
  await disablePushRegistration(environmentId);
  mocks.rpc.mockClear();
  mocks.rpc.mockImplementation(async (command, environmentId, input) => {
    if (command === "state") return { gatewayUrl: host.gatewayUrl, registration: null };
    return defaultRpc?.(command, environmentId, input);
  });
  await refreshPushRegistration(environmentId);
  const input = mocks.rpc.mock.calls.find(([command]) => command === "revoke")?.[2];
  expect(input).toMatchObject({
    recipientId: host.recipientId,
    generation: 1,
    revocationToken: prior?.revocationToken,
  });
  expect(host.status).toBe("revoked");
  expect((await loadPushRecord(environmentId))?.revocationPending).toBe(false);
});

it("retains the previous secret across an enrollment failure and retry", async () => {
  const environmentId = EnvironmentId.make("repaired-enrollment-retry");
  await seed(environmentId);
  const prior = await loadPushRecord(environmentId);
  await disablePushRegistration(environmentId);
  const defaultRpc = mocks.rpc.getMockImplementation();
  let reject = true;
  mocks.rpc.mockImplementation(async (command, environmentId, input) => {
    if (command === "register" && reject) throw new Error("Gateway offline");
    return defaultRpc?.(command, environmentId, input);
  });
  await expect(enablePushRegistration(environmentId)).rejects.toThrow("Gateway offline");
  const failed = await loadPushRecord(environmentId);
  expect(failed?.previousRevocationToken).toBe(prior?.revocationToken);
  expect(failed?.revocationToken).not.toBe(prior?.revocationToken);
  reject = false;
  await enablePushRegistration(environmentId);
  const inputs = mocks.rpc.mock.calls
    .filter(([command]) => command === "register")
    .map((call) => call[2]);
  expect(inputs).toHaveLength(2);
  expect(inputs[0].revocationToken).toBe(inputs[1].revocationToken);
  expect(inputs[0].previousRevocationToken).toBe(inputs[1].previousRevocationToken);
  expect((await loadPushRecord(environmentId))?.previousRevocationToken).toBeUndefined();
});
