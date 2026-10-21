import type { EnvironmentId } from "@supaterm/contracts";
import * as DateTime from "effect/DateTime";
import type {
  PushDescribeResult,
  PushKinds,
  PushListResult,
  PushNotificationErrorReason,
  PushPreviewLevel,
  PushRegisterInput,
  PushTestResult,
} from "@supaterm/contracts/push";
import type {
  PushInstallation,
  PushNativeConfiguration,
  SupatermPushModule,
} from "@supaterm/mobile-push";

import type {
  MobilePushRegistration,
  MobilePushSettings,
} from "../../persistence/mobile-push-store";
import { PushGatewayError, type PushGatewayClient } from "./pushGateway";

export type PushEnvironmentState =
  | { readonly state: "off" }
  | { readonly state: "unsupported" }
  | { readonly state: "permission-denied" }
  | { readonly state: "verifying" }
  | { readonly state: "waiting" }
  | { readonly state: "active"; readonly lastDeliveryAt: string | null }
  | { readonly state: "origin-not-allowed"; readonly origin: string }
  | { readonly state: "host-unsupported" }
  | { readonly state: "host-disabled" }
  | { readonly state: "gateway-unreachable"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

export type PushDeviceState =
  | { readonly state: "off" }
  | { readonly state: "unsupported" }
  | { readonly state: "permission-denied" }
  | { readonly state: "verifying" }
  | { readonly state: "ready" }
  | { readonly state: "gateway-unreachable"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

export interface PushStatusSnapshot {
  readonly device: PushDeviceState;
  readonly environments: ReadonlyMap<EnvironmentId, PushEnvironmentState>;
}

export type PushPermission = "granted" | "denied" | "undetermined";

export type PushNative = Omit<SupatermPushModule, "getHideContent" | "setHideContent">;

export interface PushHost {
  readonly describe: (environmentId: EnvironmentId) => Promise<PushDescribeResult>;
  readonly register: (environmentId: EnvironmentId, input: PushRegisterInput) => Promise<unknown>;
  readonly unregister: (environmentId: EnvironmentId, registrationId: string) => Promise<unknown>;
  readonly list: (environmentId: EnvironmentId) => Promise<PushListResult>;
  readonly test: (environmentId: EnvironmentId, registrationId: string) => Promise<PushTestResult>;
}

export interface PushChallenge {
  readonly enrollmentId: string;
  readonly code: string;
}

export class PushChallengeTimeoutError extends Error {
  constructor() {
    super("Supaterm could not verify this device. Keep the app open and try again.");
    this.name = "PushChallengeTimeoutError";
  }
}

export interface PushChallengeMailbox {
  readonly deliver: (challenge: PushChallenge) => void;
  readonly wait: (enrollmentId: string, timeoutMs: number) => Promise<string>;
  /** Ends every pending wait, so turning push off does not queue behind an unanswered challenge. */
  readonly abort: () => void;
}

const MAX_EARLY_CHALLENGES = 8;

/** The challenge push can arrive before the enrollment response that names it, so early codes wait here. */
export function createPushChallengeMailbox(): PushChallengeMailbox {
  const arrived = new Map<string, string>();
  const waiters = new Map<string, (code: string | null) => void>();
  return {
    deliver: ({ enrollmentId, code }) => {
      const waiter = waiters.get(enrollmentId);
      if (waiter) {
        waiters.delete(enrollmentId);
        waiter(code);
        return;
      }
      arrived.set(enrollmentId, code);
      for (const key of arrived.keys()) {
        if (arrived.size <= MAX_EARLY_CHALLENGES) break;
        arrived.delete(key);
      }
    },
    wait: (enrollmentId, timeoutMs) => {
      const early = arrived.get(enrollmentId);
      if (early !== undefined) {
        arrived.delete(enrollmentId);
        return Promise.resolve(early);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(enrollmentId);
          reject(new PushChallengeTimeoutError());
        }, timeoutMs);
        waiters.set(enrollmentId, (code) => {
          clearTimeout(timer);
          if (code === null) reject(new PushChallengeTimeoutError());
          else resolve(code);
        });
      });
    },
    abort: () => {
      const pending = [...waiters.values()];
      waiters.clear();
      for (const waiter of pending) waiter(null);
    },
  };
}

export type PushHostFailure = PushNotificationErrorReason | "unsupported" | "offline" | "error";

/** Hosts from before push answer `push.*` with an unknown-tag defect rather than a typed error. */
export function classifyPushHostFailure(error: unknown): PushHostFailure {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    if (error._tag === "PushNotificationError" && "reason" in error) {
      return error.reason as PushNotificationErrorReason;
    }
    if (error._tag === "EnvironmentRpcUnavailableError") return "offline";
  }
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("Unknown request tag") ? "unsupported" : "error";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function hostFailureState(error: unknown): PushEnvironmentState {
  switch (classifyPushHostFailure(error)) {
    case "unsupported":
      return { state: "host-unsupported" };
    case "disabled":
      return { state: "host-disabled" };
    case "offline":
      return { state: "waiting" };
    default:
      return {
        state: "error",
        message: errorMessage(error, "The host rejected the registration."),
      };
  }
}

type PushSetupFailure =
  | { readonly state: "gateway-unreachable"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

function gatewayFailureState(error: unknown): PushSetupFailure {
  if (error instanceof PushGatewayError && error.unreachable) {
    return { state: "gateway-unreachable", message: error.message };
  }
  return { state: "error", message: errorMessage(error, "Push notification setup failed.") };
}

class InstallationLostError extends Error {}

const installationLost = (error: unknown) =>
  error instanceof PushGatewayError && error.installationLost;

type SupportedConfiguration = Extract<PushNativeConfiguration, { supported: true }>;

const CHALLENGE_MIN_WAIT_MS = 60_000;
const CHALLENGE_MAX_WAIT_MS = 10 * 60_000;
/**
 * Every challenge is a visible alert and the gateway allows a handful per token an hour,
 * so the reconnects, token callbacks, and app-state changes that each sync must not
 * each enroll again after a failure. Only the user's retry skips the wait.
 */
const ENROLL_RETRY_MS = 60_000;

export interface PushRegistrarDeps {
  readonly native: PushNative;
  readonly gateway: PushGatewayClient;
  readonly host: PushHost;
  readonly permissions: {
    readonly get: () => Promise<PushPermission>;
    readonly request: () => Promise<PushPermission>;
  };
  readonly deviceToken: () => Promise<string>;
  readonly store: {
    readonly load: () => Promise<MobilePushSettings>;
    readonly save: (settings: MobilePushSettings) => Promise<void>;
  };
  readonly challenges: PushChallengeMailbox;
  readonly randomId: () => string;
  readonly deviceName?: string;
  readonly now?: () => number;
  readonly onStatus: (snapshot: PushStatusSnapshot) => void;
}

export interface PushEnvironments {
  readonly saved: ReadonlySet<EnvironmentId>;
  readonly connected: ReadonlySet<EnvironmentId>;
}

export interface PushRegistrar {
  /** Converges gateway, host, and Keychain state with the settings. Safe to call on every reconnect. */
  readonly sync: (environments: PushEnvironments) => Promise<void>;
  /** Like sync, but enrolls again at once instead of waiting out a recent enrollment failure. */
  readonly retry: (environments: PushEnvironments) => Promise<void>;
  readonly enable: (preview: PushPreviewLevel) => Promise<void>;
  readonly disable: () => Promise<void>;
  readonly updatePreferences: (patch: {
    readonly preview?: PushPreviewLevel;
    readonly kinds?: PushKinds;
  }) => Promise<void>;
  /** Removes the environment's registration before the environment itself is forgotten. */
  readonly forgetEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  readonly sendTest: (environmentId: EnvironmentId) => Promise<PushTestResult["status"]>;
}

const noop = () => {};

const sameKinds = (left: PushKinds, right: PushKinds) =>
  left.approval === right.approval &&
  left.input === right.input &&
  left.completion === right.completion &&
  left.failure === right.failure &&
  left["usage-limit"] === right["usage-limit"];

export function createPushRegistrar(deps: PushRegistrarDeps): PushRegistrar {
  const now = deps.now ?? Date.now;
  let enrollFailure: { readonly until: number; readonly error: unknown } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let environments: PushEnvironments = { saved: new Set(), connected: new Set() };
  // Reconnects can fire in bursts; syncs that have not started yet collapse into one.
  let latestEnvironments = environments;
  let queuedSync: Promise<void> | null = null;
  let settings: MobilePushSettings | null = null;
  let device: PushDeviceState = { state: "off" };
  const states = new Map<EnvironmentId, PushEnvironmentState>();

  const serial = <A>(operation: () => Promise<A>): Promise<A> => {
    const run = queue.then(operation, operation);
    queue = run.then(noop, noop);
    return run;
  };

  const publish = () => {
    for (const environmentId of states.keys()) {
      if (!environments.saved.has(environmentId)) states.delete(environmentId);
    }
    deps.onStatus({ device, environments: new Map(states) });
  };

  const settleAll = (state: Extract<PushDeviceState, PushEnvironmentState>) => {
    device = state;
    for (const environmentId of environments.saved) states.set(environmentId, state);
    publish();
  };

  const denyPermission = () => settleAll({ state: "permission-denied" });

  const load = async () => (settings ??= await deps.store.load());

  const commit = async (next: MobilePushSettings) => {
    settings = next;
    await deps.store.save(next);
  };

  const findRegistration = async (environmentId: EnvironmentId) =>
    (await load()).registrations.find((candidate) => candidate.environmentId === environmentId);

  /** Deletes the handle at the gateway, or keeps it for a later retry when the gateway is down. */
  const dropHandle = async (installationId: string, handle: string) => {
    const installation = await deps.native.getInstallation();
    if (installation?.installationId !== installationId) return;
    try {
      await deps.gateway.deleteHandle(installation, handle);
    } catch (error) {
      if (installationLost(error)) return;
      const current = await load();
      await commit({
        ...current,
        retiredHandles: [...current.retiredHandles, { installationId, handle }],
      });
    }
  };

  const retryRetiredHandles = async (installation: PushInstallation | null) => {
    const current = await load();
    if (current.retiredHandles.length === 0) return;
    const remaining = [];
    for (const retired of current.retiredHandles) {
      if (installation?.installationId !== retired.installationId) continue;
      try {
        await deps.gateway.deleteHandle(installation, retired.handle);
      } catch (error) {
        if (!installationLost(error)) remaining.push(retired);
      }
    }
    await commit({ ...(await load()), retiredHandles: remaining });
  };

  const retire = async (registration: MobilePushRegistration, options: { host: boolean }) => {
    if (options.host) {
      await deps.host
        .unregister(registration.environmentId, registration.registrationId)
        .catch(noop);
    }
    await deps.native.deleteBinding(registration.registrationId).catch(noop);
    const current = await load();
    await commit({
      ...current,
      registrations: current.registrations.filter(
        (candidate) => candidate.registrationId !== registration.registrationId,
      ),
    });
    await dropHandle(registration.installationId, registration.handle);
  };

  /** Deleting the installation drops every handle at once; local state goes only once it is gone. */
  const deleteInstallation = async () => {
    const installation = await deps.native.getInstallation();
    if (installation === null) return;
    try {
      await deps.gateway.deleteInstallation(installation);
    } catch (error) {
      if (!installationLost(error)) return;
    }
    await deps.native.clearInstallation();
  };

  const removeStrayBindings = async () => {
    const current = await load();
    const known = new Set(current.registrations.map((registration) => registration.registrationId));
    for (const binding of await deps.native.listBindings()) {
      if (!known.has(binding.registrationId)) {
        await deps.native.deleteBinding(binding.registrationId).catch(noop);
      }
    }
    await deps.native.deleteOrphanKeys().catch(noop);
  };

  const ensureInstallation = async (config: SupportedConfiguration): Promise<PushInstallation> => {
    const token = await deps.deviceToken();
    const current = await deps.native.getInstallation();
    const sameDestination =
      current !== null &&
      current.topic === config.topic &&
      current.environment === config.apnsEnvironment;
    if (sameDestination && current.token === token) return current;

    if (enrollFailure !== null && now() < enrollFailure.until) throw enrollFailure.error;
    device = { state: "verifying" };
    for (const environmentId of environments.saved) {
      if (environments.connected.has(environmentId))
        states.set(environmentId, { state: "verifying" });
    }
    publish();

    const request = { token, topic: config.topic, environment: config.apnsEnvironment };
    let owner = sameDestination ? current : null;
    let confirmed;
    try {
      let enrollment;
      try {
        enrollment = await deps.gateway.enroll(request, owner ?? undefined);
      } catch (error) {
        if (owner === null || !installationLost(error)) {
          throw error;
        }
        owner = null;
        enrollment = await deps.gateway.enroll(request);
      }
      const waitMs = Math.min(
        CHALLENGE_MAX_WAIT_MS,
        Math.max(CHALLENGE_MIN_WAIT_MS, enrollment.expiresAt - now()),
      );
      const code = await deps.challenges.wait(enrollment.enrollmentId, waitMs);
      confirmed = await deps.gateway.confirm(enrollment.enrollmentId, code);
    } catch (error) {
      const waitMs =
        error instanceof PushGatewayError && error.retryAfterMs !== null
          ? Math.max(error.retryAfterMs, ENROLL_RETRY_MS)
          : ENROLL_RETRY_MS;
      enrollFailure = { until: now() + waitMs, error };
      throw error;
    }
    enrollFailure = null;
    const ownerToken = confirmed.ownerToken ?? owner?.ownerToken;
    if (ownerToken === undefined) {
      throw new PushGatewayError({ status: 502, code: "invalid_response" });
    }
    const next: PushInstallation = {
      installationId: confirmed.installationId,
      ownerToken,
      token,
      topic: config.topic,
      environment: config.apnsEnvironment,
    };
    await deps.native.setInstallation(next);
    if (current !== null && current.installationId !== next.installationId) {
      await deps.gateway.deleteInstallation(current).catch(noop);
    }
    return next;
  };

  const mintHandle = async (installation: PushInstallation, hostKey: string) => {
    try {
      return await deps.gateway.createHandle(installation, hostKey);
    } catch (error) {
      throw installationLost(error) ? new InstallationLostError() : error;
    }
  };

  const registerInput = (
    registration: Pick<
      MobilePushRegistration,
      "registrationId" | "keyId" | "publicKey" | "handle" | "gatewayOrigin"
    >,
    current: MobilePushSettings,
  ): PushRegisterInput => ({
    registrationId: registration.registrationId,
    gatewayOrigin: registration.gatewayOrigin,
    handle: registration.handle,
    recipientKey: { keyId: registration.keyId, publicKey: registration.publicKey },
    preview: current.preview,
    kinds: current.kinds,
    ...(deps.deviceName ? { deviceName: deps.deviceName.slice(0, 64) } : {}),
  });

  const saveRegistration = async (registration: MobilePushRegistration) => {
    const current = await load();
    await commit({
      ...current,
      registrations: [
        ...current.registrations.filter(
          (candidate) => candidate.environmentId !== registration.environmentId,
        ),
        registration,
      ],
    });
  };

  const refreshRegistration = async (
    existing: MobilePushRegistration,
    installation: PushInstallation,
  ): Promise<PushEnvironmentState | null> => {
    const current = await load();
    const remote = (await deps.host.list(existing.environmentId)).registrations.find(
      (registration) => registration.registrationId === existing.registrationId,
    );
    const handleUsable =
      existing.installationId === installation.installationId && remote?.status !== "gone";
    const lastDeliveryAt =
      remote?.lastDeliveryAt === undefined ? null : DateTime.formatIso(remote.lastDeliveryAt);
    if (
      handleUsable &&
      remote?.status === "active" &&
      existing.preview === current.preview &&
      sameKinds(existing.kinds, current.kinds)
    ) {
      return { state: "active", lastDeliveryAt };
    }
    const handle = handleUsable
      ? existing.handle
      : await mintHandle(installation, existing.hostKey);
    try {
      await deps.host.register(
        existing.environmentId,
        registerInput({ ...existing, handle }, current),
      );
    } catch (error) {
      if (handle !== existing.handle) await dropHandle(installation.installationId, handle);
      if (classifyPushHostFailure(error) === "conflict") {
        await retire(existing, { host: false });
        return null;
      }
      throw error;
    }
    await saveRegistration({
      ...existing,
      handle,
      installationId: installation.installationId,
      preview: current.preview,
      kinds: current.kinds,
    });
    if (handle !== existing.handle) {
      await dropHandle(existing.installationId, existing.handle);
    }
    return { state: "active", lastDeliveryAt };
  };

  const createRegistration = async (
    environmentId: EnvironmentId,
    describe: PushDescribeResult,
    installation: PushInstallation,
  ): Promise<PushEnvironmentState> => {
    const current = await load();
    const key = await deps.native.generateRecipientKey();
    const handle = await mintHandle(installation, describe.hostKey);
    const registration: MobilePushRegistration = {
      environmentId,
      registrationId: deps.randomId().toLowerCase(),
      keyId: key.keyId,
      publicKey: key.publicKey,
      hostKey: describe.hostKey,
      handle,
      gatewayOrigin: deps.gateway.origin,
      installationId: installation.installationId,
      preview: current.preview,
      kinds: current.kinds,
    };
    // The binding exists before the host can send, so the first alert already decrypts.
    await deps.native.saveBinding({
      registrationId: registration.registrationId,
      keyId: registration.keyId,
      environmentId,
      hostKey: registration.hostKey,
    });
    try {
      await deps.host.register(environmentId, registerInput(registration, current));
    } catch (error) {
      await deps.native.deleteBinding(registration.registrationId).catch(noop);
      await dropHandle(installation.installationId, handle);
      throw error;
    }
    await saveRegistration(registration);
    return { state: "active", lastDeliveryAt: null };
  };

  const registerEnvironment = async (
    environmentId: EnvironmentId,
    installation: PushInstallation,
  ): Promise<PushEnvironmentState> => {
    let describe: PushDescribeResult;
    try {
      describe = await deps.host.describe(environmentId);
    } catch (error) {
      return hostFailureState(error);
    }
    if (!describe.enabled) return { state: "host-disabled" };
    if (!describe.gatewayOrigins.includes(deps.gateway.origin)) {
      return { state: "origin-not-allowed", origin: deps.gateway.origin };
    }
    try {
      const existing = await findRegistration(environmentId);
      if (existing !== undefined) {
        const bound = (await deps.native.listBindings()).some(
          (binding) =>
            binding.registrationId === existing.registrationId && binding.keyId === existing.keyId,
        );
        if (
          !bound ||
          existing.hostKey !== describe.hostKey ||
          existing.gatewayOrigin !== deps.gateway.origin
        ) {
          await retire(existing, { host: true });
        } else {
          const refreshed = await refreshRegistration(existing, installation);
          if (refreshed !== null) return refreshed;
        }
      }
      return await createRegistration(environmentId, describe, installation);
    } catch (error) {
      if (error instanceof InstallationLostError) throw error;
      if (error instanceof PushGatewayError) return gatewayFailureState(error);
      return hostFailureState(error);
    }
  };

  const runSync = async () => {
    const current = await load();
    for (const registration of current.registrations) {
      if (!environments.saved.has(registration.environmentId)) {
        await retire(registration, { host: false });
      }
    }
    const config = deps.native.configuration();
    if (!current.enabled || !config.supported) {
      if (config.supported) {
        for (const registration of (await load()).registrations) {
          await retire(registration, {
            host: environments.connected.has(registration.environmentId),
          });
        }
        await retryRetiredHandles(await deps.native.getInstallation());
        await deleteInstallation();
        await removeStrayBindings();
      }
      settleAll(config.supported ? { state: "off" } : { state: "unsupported" });
      return;
    }

    if ((await deps.permissions.get()) !== "granted") {
      await deleteInstallation();
      denyPermission();
      return;
    }

    let installation: PushInstallation;
    try {
      installation = await ensureInstallation(config);
    } catch (error) {
      settleAll(gatewayFailureState(error));
      return;
    }
    device = { state: "ready" };
    await retryRetiredHandles(installation);

    let reenrolled = false;
    for (const environmentId of environments.saved) {
      if (!environments.connected.has(environmentId)) {
        const registration = await findRegistration(environmentId);
        states.set(
          environmentId,
          registration?.installationId === installation.installationId
            ? { state: "active", lastDeliveryAt: null }
            : { state: "waiting" },
        );
        continue;
      }
      let state: PushEnvironmentState;
      try {
        state = await registerEnvironment(environmentId, installation);
      } catch (error) {
        if (!(error instanceof InstallationLostError) || reenrolled) {
          state = gatewayFailureState(error);
        } else {
          reenrolled = true;
          await deps.native.clearInstallation();
          try {
            installation = await ensureInstallation(config);
            state = await registerEnvironment(environmentId, installation);
          } catch (retryError) {
            state = gatewayFailureState(retryError);
          }
        }
      }
      states.set(environmentId, state);
      publish();
    }
    await removeStrayBindings();
    publish();
  };

  const syncLatest = async () => {
    environments = latestEnvironments;
    await runSync();
  };

  return {
    sync: (next) => {
      latestEnvironments = next;
      queuedSync ??= serial(async () => {
        queuedSync = null;
        await syncLatest();
      });
      return queuedSync;
    },
    retry: (next) => {
      enrollFailure = null;
      latestEnvironments = next;
      return serial(syncLatest);
    },
    enable: (preview) =>
      serial(async () => {
        enrollFailure = null;
        const current = await load();
        await commit({ ...current, enabled: true, preview });
        if ((await deps.permissions.request()) !== "granted") {
          denyPermission();
          return;
        }
        await runSync();
      }),
    disable: () => {
      deps.challenges.abort();
      return serial(async () => {
        await commit({ ...(await load()), enabled: false });
        await runSync();
      });
    },
    updatePreferences: (patch) =>
      serial(async () => {
        await commit({ ...(await load()), ...patch });
        await runSync();
      }),
    forgetEnvironment: (environmentId) =>
      serial(async () => {
        const registration = await findRegistration(environmentId);
        if (registration !== undefined) await retire(registration, { host: true });
      }),
    sendTest: (environmentId) =>
      serial(async () => {
        const registration = await findRegistration(environmentId);
        if (registration === undefined) {
          throw new Error("Notifications are not set up for this environment yet.");
        }
        const result = await deps.host.test(environmentId, registration.registrationId);
        if (result.status === "gone") await runSync();
        return result.status;
      }),
  };
}
