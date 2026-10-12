import {
  createAtomCommandScheduler,
  squashAtomCommandFailure,
} from "@supacode/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { EnvironmentId } from "@supacode/contracts";
import {
  type PushConfirmInput,
  type PushPreferences,
  type PushEnrollmentData,
  PushNotificationError,
  type PushRegistration,
} from "@supacode/contracts/push";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import { encodeBase64 } from "@supacode/shared/relay/protocol";
import * as Schema from "effect/Schema";
import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { runtime } from "../../lib/runtime";
import * as MobilePushStore from "../../persistence/mobile-push-store";
import * as MobileStorage from "../../persistence/mobile-storage";
import { appAtomRegistry } from "../../state/atom-registry";
import { pushCommands, pushRegistrationAtom, runPushCommand } from "../../state/push";

export const pushDeviceId = () =>
  runtime.runPromise(
    MobileStorage.MobileStorage.pipe(Effect.flatMap((storage) => storage.loadOrCreateDeviceId)),
  );
export const loadPushRecord = (environmentId: EnvironmentId) =>
  runtime.runPromise(
    MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.load(environmentId))),
  );
const ensurePushRecord = (environmentId: EnvironmentId) =>
  runtime.runPromise(
    MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.ensure(environmentId))),
  );
const savePushRecord = (record: MobilePushStore.MobilePushRecord) =>
  runtime.runPromise(
    MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.save(record))),
  );

const isPushError = Schema.is(PushNotificationError);

function publish(
  environmentId: EnvironmentId,
  registration: PushRegistration | null,
  status: "ready" | "registering" | "failed" = "ready",
) {
  appAtomRegistry.set(pushRegistrationAtom(environmentId), { registration, status });
}

export function hasNotificationPermission(permission: Notifications.NotificationPermissionsStatus) {
  const status = permission.ios?.status;
  return (
    permission.granted ||
    status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    status === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

async function confirmRegistration(
  environmentId: EnvironmentId,
  data: Omit<typeof PushConfirmInput.Type, "deviceId">,
) {
  const registration = await runPushCommand(pushCommands.confirm, environmentId, {
    ...data,
    deviceId: await pushDeviceId(),
  });
  const record = await ensurePushRecord(environmentId);
  await savePushRecord({ ...record, registration, preferences: registration.preferences });
  publish(environmentId, registration);
}

async function refreshRegistration(environmentId: EnvironmentId, requestedEnabled?: boolean) {
  if (Platform.OS !== "ios") return;
  let record = await ensurePushRecord(environmentId);
  const deviceId = await pushDeviceId();
  const prior = await runPushCommand(pushCommands.state, environmentId, { deviceId });
  const ownedRegistration = prior.registration ?? record.registration;
  if (
    record.revocationPending ||
    (!record.preferences.enabled &&
      ownedRegistration?.status !== "revoked" &&
      ownedRegistration !== null)
  ) {
    if (ownedRegistration !== null) {
      await runPushCommand(pushCommands.revoke, environmentId, {
        deviceId,
        recipientId: ownedRegistration.recipientId,
        generation: ownedRegistration.generation,
        revocationToken: record.revocationToken,
      });
    }
    record = {
      ...record,
      registration: ownedRegistration === null ? null : { ...ownedRegistration, status: "revoked" },
      revocationPending: false,
    };
    await savePushRecord(record);
  }
  const preferences = {
    ...record.preferences,
    enabled: requestedEnabled ?? record.preferences.enabled,
  };
  if (!preferences.enabled) {
    publish(environmentId, record.registration);
    return;
  }
  if (prior.registration?.status === "pending" && (await confirmSavedRegistration(environmentId)))
    return;
  publish(environmentId, prior.registration);
  const permission = await Notifications.getPermissionsAsync();
  if (!hasNotificationPermission(permission)) {
    if (prior.registration?.status === "active") await disableRegistration(environmentId);
    return;
  }
  const nativeEnvironment = await Application.getIosPushNotificationServiceEnvironmentAsync();
  const topic = Application.applicationId;
  if (nativeEnvironment === null || topic === null)
    throw new Error("Install a Supacode build with notification support.");
  const nativeToken = await Notifications.getDevicePushTokenAsync();
  if (nativeToken.type !== "ios") throw new Error("This device does not have an APNs token.");
  if (record.registration?.status === "revoked" && record.previousRevocationToken === undefined) {
    const revocationToken = await runtime.runPromise(
      Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomBytes(32)),
        Effect.map(encodeBase64),
      ),
    );
    record = { ...record, previousRevocationToken: record.revocationToken, revocationToken };
    await savePushRecord(record);
  }
  publish(environmentId, prior.registration, "registering");
  try {
    const registration = await runPushCommand(pushCommands.register, environmentId, {
      deviceId,
      token: nativeToken.data,
      topic,
      environment: nativeEnvironment === "development" ? "sandbox" : "production",
      revocationToken: record.revocationToken,
      ...(record.previousRevocationToken === undefined
        ? {}
        : { previousRevocationToken: record.previousRevocationToken }),
      preferences,
    });
    const { previousRevocationToken: _, ...registeredRecord } = record;
    await savePushRecord({ ...registeredRecord, registration, preferences });
    publish(
      environmentId,
      registration,
      registration.status === "pending" ? "registering" : "ready",
    );
    if (registration.status === "pending") await confirmSavedRegistration(environmentId);
  } catch (error) {
    publish(environmentId, prior.registration, "failed");
    throw error;
  }
}

async function disableRegistration(environmentId: EnvironmentId) {
  const record = await loadPushRecord(environmentId);
  if (record === null || record.registration === null) return;
  const registration = record.registration;
  const preferences = { ...record.preferences, enabled: false };
  await savePushRecord({ ...record, preferences, revocationPending: true });
  const direct = fetch(`${registration.gatewayUrl}/v1/push/device-revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      recipientId: registration.recipientId,
      generation: registration.generation,
      revocationToken: record.revocationToken,
    }),
    signal: AbortSignal.timeout(10_000),
  }).then((response) => response.ok);
  const host = pushDeviceId().then((deviceId) =>
    runPushCommand(pushCommands.revoke, environmentId, {
      deviceId,
      recipientId: registration.recipientId,
      generation: registration.generation,
      revocationToken: record.revocationToken,
    }),
  );
  const results = await Promise.allSettled([
    direct.then((accepted) => {
      if (!accepted) throw new Error("Gateway revocation failed.");
      return "gateway" as const;
    }),
    host.then(() => "host" as const),
  ]);
  const hostRevoked = results[1]?.status === "fulfilled";
  if (!results.some((result) => result.status === "fulfilled")) {
    throw new Error(
      "Could not reach the environment or notification gateway. Try again when connected.",
    );
  }
  const revoked: PushRegistration = { ...registration, status: "revoked", preferences };
  await savePushRecord({
    ...record,
    preferences,
    registration: revoked,
    revocationPending: !hostRevoked,
  });
  publish(environmentId, revoked);
}

async function updatePreferences(
  environmentId: EnvironmentId,
  patch: Partial<Omit<PushPreferences, "enabled">>,
) {
  const record = await ensurePushRecord(environmentId);
  const preferences = { ...record.preferences, ...patch };
  const registration = await runPushCommand(pushCommands.preferences, environmentId, {
    deviceId: await pushDeviceId(),
    preferences,
  });
  await savePushRecord({ ...record, registration, preferences });
  publish(environmentId, registration);
}

async function enableRegistration(environmentId: EnvironmentId) {
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  if (!hasNotificationPermission(permission))
    throw new Error("Enable notifications for Supacode in iOS Settings.");
  await refreshRegistration(environmentId, true);
}

const scheduler = createAtomCommandScheduler();
async function serialize<A>(environmentId: EnvironmentId, operation: () => Promise<A>): Promise<A> {
  const result = await scheduler.schedule(
    appAtomRegistry,
    { mode: "serial", key: (id: EnvironmentId) => id },
    environmentId,
    async () => AsyncResult.success(await operation()),
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
export const refreshPushRegistration = (environmentId: EnvironmentId, enabled?: boolean) =>
  serialize(environmentId, () => refreshRegistration(environmentId, enabled));
export const enablePushRegistration = (environmentId: EnvironmentId) =>
  serialize(environmentId, () => enableRegistration(environmentId));
export const disablePushRegistration = (environmentId: EnvironmentId) =>
  serialize(environmentId, () => disableRegistration(environmentId));
export const updatePushPreferences = (
  environmentId: EnvironmentId,
  patch: Partial<Omit<PushPreferences, "enabled">>,
) => serialize(environmentId, () => updatePreferences(environmentId, patch));
export const confirmPushRegistration = (
  environmentId: EnvironmentId,
  data: Omit<typeof PushConfirmInput.Type, "deviceId">,
) => serialize(environmentId, () => confirmRegistration(environmentId, data));
const loadEnrollmentChallenges = (recipientId: string) =>
  runtime.runPromise(
    MobilePushStore.MobilePushStore.pipe(
      Effect.flatMap((store) => store.enrollmentChallenges(recipientId)),
    ),
  );
export const saveEnrollmentChallenge = (data: typeof PushEnrollmentData.Type) =>
  runtime.runPromise(
    MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.saveChallenge(data))),
  );
async function confirmSavedRegistration(environmentId: EnvironmentId): Promise<boolean> {
  const record = await loadPushRecord(environmentId);
  if (record?.registration?.status !== "pending" || !record.preferences.enabled) return false;
  const candidates = await loadEnrollmentChallenges(record.registration.recipientId);
  for (let index = candidates.length - 1; index >= 0; index--) {
    const challenge = candidates[index];
    if (challenge === undefined) continue;
    if (challenge.generation !== record.registration.generation) continue;
    try {
      await confirmRegistration(environmentId, challenge);
      return true;
    } catch (error) {
      if (!isPushError(error) || error.reason === "unavailable" || error.reason === "storage")
        throw error;
    }
  }
  return false;
}
export const confirmSavedPushRegistration = (environmentId: EnvironmentId) =>
  serialize(environmentId, () => confirmSavedRegistration(environmentId));
export const removePushRegistration = (environmentId: EnvironmentId) =>
  serialize(environmentId, async () => {
    const record = await loadPushRecord(environmentId);
    if (record !== null && record.registration !== null && record.registration.status !== "revoked")
      await disableRegistration(environmentId);
    await runtime.runPromise(
      MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.remove(environmentId))),
    );
  });
