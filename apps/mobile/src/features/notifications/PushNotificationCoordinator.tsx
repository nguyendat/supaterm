import { useAtomValue } from "@effect/atom-react";
import { useLinkTo } from "@react-navigation/native";
import { type EnvironmentId, ThreadId } from "@supacode/contracts";
import { threadNotificationAttention } from "@supacode/shared/threadNotificationAttention";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PushNotificationError } from "@supacode/contracts/push";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

import { runtime } from "../../lib/runtime";
import * as MobilePushStore from "../../persistence/mobile-push-store";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";
import {
  pendingPushTapAtom,
  pushCommands,
  pushRegistrationAtom,
  pushEnrollmentChallengeAtom,
  runPushCommand,
} from "../../state/push";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { enrollmentData, notificationData, sameNotification } from "./notificationData";
import {
  confirmSavedPushRegistration,
  saveEnrollmentChallenge,
  loadPushRecord,
  pushDeviceId,
  refreshPushRegistration,
} from "./pushRegistration";

const isPushError = Schema.is(PushNotificationError);

export function PushNotificationCoordinator({ pathname }: { readonly pathname: string }) {
  const { savedConnectionsById } = useSavedRemoteConnections();
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const enrollment = enrollmentData(notification.request.content.data) !== null;
        return {
          shouldShowBanner: !enrollment,
          shouldShowList: !enrollment,
          shouldPlaySound: !enrollment,
          shouldSetBadge: false,
        };
      },
    });
    let disposed = false;
    const persistEnrollment = async (notification: Notifications.Notification) => {
      const challenge = enrollmentData(notification.request.content.data);
      if (challenge === null) return false;
      await saveEnrollmentChallenge(challenge);
      if (!disposed) appAtomRegistry.set(pushEnrollmentChallengeAtom, challenge);
      return true;
    };
    const received = Notifications.addNotificationReceivedListener((notification) => {
      void persistEnrollment(notification).catch(() => undefined);
    });
    const persistResponse = async (response: Notifications.NotificationResponse) => {
      if (await persistEnrollment(response.notification)) {
        await Notifications.clearLastNotificationResponseAsync();
        return;
      }
      const data = notificationData(response.notification.request.content.data);
      if (data === null) return;
      const pending = await runtime.runPromise(
        MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.enqueueTap(data))),
      );
      if (!disposed && !sameNotification(appAtomRegistry.get(pendingPushTapAtom), pending))
        appAtomRegistry.set(pendingPushTapAtom, pending);
      await Notifications.clearLastNotificationResponseAsync();
    };
    const responses = Notifications.addNotificationResponseReceivedListener((response) => {
      void persistResponse(response).catch(() => undefined);
    });
    void runtime
      .runPromise(MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.pending)))
      .then((pending) => {
        if (!disposed && appAtomRegistry.get(pendingPushTapAtom) === null)
          appAtomRegistry.set(pendingPushTapAtom, pending);
      })
      .catch(() => undefined);
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => (response === null ? undefined : persistResponse(response)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      responses.remove();
      received.remove();
      Notifications.setNotificationHandler(null);
    };
  }, []);

  if (Platform.OS !== "ios") return null;
  return Object.keys(savedConnectionsById).map((id) => (
    <EnvironmentPushCoordinator key={id} environmentId={id as EnvironmentId} pathname={pathname} />
  ));
}

function EnvironmentPushCoordinator({
  environmentId,
  pathname,
}: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
}) {
  const registrationState = useAtomValue(pushRegistrationAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const pending = useAtomValue(pendingPushTapAtom);
  const challenge = useAtomValue(pushEnrollmentChallengeAtom);
  const permitted = useAtomValue(pushCommands.register.permissionAtom(environmentId));
  const linkTo = useLinkTo();
  const recipientId = registrationState.registration?.recipientId;
  const refreshing = useRef(false);
  const consumingTap = useRef<typeof pending>(null);
  const [resolvedTap, setResolvedTap] = useState<{
    readonly pending: NonNullable<typeof pending>;
    readonly threadId: ThreadId;
    readonly sequence: number;
  } | null>(null);
  const live = shell.status === "live";

  const refresh = useCallback(async () => {
    if (!permitted || refreshing.current || AppState.currentState !== "active") return;
    refreshing.current = true;
    try {
      await refreshPushRegistration(environmentId);
    } catch {
      appAtomRegistry.set(pushRegistrationAtom(environmentId), {
        registration: appAtomRegistry.get(pushRegistrationAtom(environmentId)).registration,
        status: "failed",
      });
    } finally {
      refreshing.current = false;
    }
  }, [environmentId, permitted]);

  useEffect(() => {
    let disposed = false;
    void loadPushRecord(environmentId)
      .then((record) => {
        if (!disposed && record !== null)
          appAtomRegistry.set(pushRegistrationAtom(environmentId), {
            registration: record.registration,
            status: "ready",
          });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [environmentId]);

  useEffect(() => {
    if (live) void refresh();
  }, [live, refresh]);
  useEffect(() => {
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active" && live) void refresh();
    });
    const tokens = Notifications.addPushTokenListener(() => {
      if (live) void refresh();
    });
    return () => {
      foreground.remove();
      tokens.remove();
    };
  }, [live, refresh]);

  useEffect(() => {
    if (
      !live ||
      !permitted ||
      registrationState.registration?.status !== "pending" ||
      (challenge !== null && challenge.recipientId !== recipientId)
    )
      return;
    void confirmSavedPushRegistration(environmentId).catch(() => {
      appAtomRegistry.set(pushRegistrationAtom(environmentId), {
        registration: appAtomRegistry.get(pushRegistrationAtom(environmentId)).registration,
        status: "failed",
      });
    });
  }, [
    challenge,
    environmentId,
    live,
    permitted,
    recipientId,
    registrationState.registration?.status,
  ]);

  const selected = pathname.match(/^\/threads\/([^/]+)\/([^/]+)/);
  const selectedThreadId =
    selected?.[1] === encodeURIComponent(environmentId) && selected[2] !== undefined
      ? ThreadId.make(decodeURIComponent(selected[2]))
      : null;
  const selectedThread = Option.isSome(shell.snapshot)
    ? shell.snapshot.value.threads.find((thread) => thread.id === selectedThreadId)
    : undefined;
  const attention =
    selectedThread === undefined ? undefined : threadNotificationAttention(selectedThread)?.key;

  const report = useEffectEvent(
    async (
      foreground: boolean,
      threadId: ThreadId | null,
      expectedAttention: string | undefined,
    ) => {
      if (Option.isNone(shell.snapshot)) return;
      const current = shell.snapshot.value.threads.find((thread) => thread.id === threadId);
      if (
        (current === undefined ? undefined : threadNotificationAttention(current)?.key) !==
        expectedAttention
      )
        return;
      await runPushCommand(pushCommands.presence, environmentId, {
        deviceId: await pushDeviceId(),
        foreground,
        threadId,
        sequence: shell.snapshot.value.snapshotSequence,
      });
    },
  );
  useEffect(() => {
    if (!live || !permitted || registrationState.registration?.status !== "active") return;
    void report(AppState.currentState === "active", selectedThreadId, attention).catch(
      () => undefined,
    );
    const interval = setInterval(() => {
      if (AppState.currentState === "active")
        void report(true, selectedThreadId, attention).catch(() => undefined);
    }, 30_000);
    const subscription = AppState.addEventListener("change", (state) => {
      void report(state === "active", selectedThreadId, attention).catch(() => undefined);
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [attention, live, permitted, registrationState.registration?.status, selectedThreadId]);

  useEffect(() => {
    if (!live || pending === null || recipientId !== pending.recipientId) return;
    let disposed = false;
    void (async () => {
      const resolved = await runPushCommand(pushCommands.resolve, environmentId, {
        ...pending,
        deviceId: await pushDeviceId(),
      });
      if (!disposed) setResolvedTap({ pending, ...resolved });
    })()
      .catch(async (error) => {
        if (!isPushError(error) || (error.reason !== "not-found" && error.reason !== "rejected"))
          return;
        await runtime.runPromise(
          MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.finishTap(pending))),
        );
        if (!disposed && appAtomRegistry.get(pendingPushTapAtom) === pending)
          appAtomRegistry.set(pendingPushTapAtom, null);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [environmentId, live, pending, recipientId]);

  useEffect(() => {
    if (
      resolvedTap === null ||
      pending !== resolvedTap.pending ||
      !live ||
      Option.isNone(shell.snapshot) ||
      shell.snapshot.value.snapshotSequence < resolvedTap.sequence
    )
      return;
    if (appAtomRegistry.get(pendingPushTapAtom) !== pending) return;
    if (consumingTap.current === pending) return;
    consumingTap.current = pending;
    void (async () => {
      linkTo(
        `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(resolvedTap.threadId)}`,
      );
      await runtime.runPromise(
        MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.finishTap(pending))),
      );
      if (appAtomRegistry.get(pendingPushTapAtom) === pending)
        appAtomRegistry.set(pendingPushTapAtom, null);
    })()
      .catch(() => undefined)
      .finally(() => {
        consumingTap.current = null;
      });
  }, [environmentId, linkTo, live, pending, resolvedTap, shell.snapshot]);

  return null;
}
