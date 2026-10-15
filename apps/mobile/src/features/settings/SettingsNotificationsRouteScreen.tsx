import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PUSH_PREFERENCES, type PushNotificationKind } from "@supaterm/contracts/push";
import { useCallback, useEffect, useState } from "react";
import * as Notifications from "expo-notifications";
import { Alert, AppState, Linking, Platform } from "react-native";

import { ScreenScrollView } from "../../components/ScreenScrollView";
import { AppText } from "../../components/AppText";
import type { SavedRemoteConnection } from "../../lib/connection";
import { pushCommands, pushRegistrationAtom } from "../../state/push";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  disablePushRegistration,
  enablePushRegistration,
  hasNotificationPermission,
  refreshPushRegistration,
  updatePushPreferences,
} from "../notifications/pushRegistration";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import PushPreview from "../../../modules/supacode-push-preview";

const KIND_LABELS: Record<PushNotificationKind, string> = {
  approval: "Approval needed",
  input: "Input needed",
  completion: "Thread completed",
  failure: "Thread failed",
  "usage-limit": "Usage limit reached",
};

export function SettingsNotificationsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [permission, setPermission] = useState(false);
  const refreshPermission = useCallback(() => {
    if (Platform.OS !== "ios") return;
    void Notifications.getPermissionsAsync()
      .then((result) => setPermission(hasNotificationPermission(result)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    refreshPermission();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshPermission();
    });
    return () => subscription.remove();
  }, [refreshPermission]);

  return (
    <SettingsScreen title="Notifications">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 py-4"
      >
        <SettingsSection title="This device">
          <SettingsRow
            icon="bell"
            label="iOS permission"
            value={permission ? "Allowed" : "Not allowed"}
            onPress={() => {
              void Linking.openSettings();
            }}
          />
        </SettingsSection>
        <AppText className="px-2 text-sm text-foreground-muted">
          Receive an alert when an environment needs attention. Tap it to reconnect and open the
          thread.
        </AppText>
        {Object.values(savedConnectionsById).map((connection) => (
          <EnvironmentNotifications
            key={connection.environmentId}
            connection={connection}
            permission={permission}
            refreshPermission={refreshPermission}
          />
        ))}
        {Object.keys(savedConnectionsById).length === 0 ? (
          <AppText className="px-2 text-sm text-foreground-muted">
            Add an environment to enable notifications.
          </AppText>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentNotifications({
  connection,
  permission,
  refreshPermission,
}: {
  readonly connection: SavedRemoteConnection;
  readonly permission: boolean;
  readonly refreshPermission: () => void;
}) {
  const environmentId = connection.environmentId;
  const state = useAtomValue(pushRegistrationAtom(environmentId));
  const permitted = useAtomValue(pushCommands.register.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const registration = state.registration;
  const preferences = registration?.preferences ?? DEFAULT_PUSH_PREFERENCES;
  const enabled =
    permission &&
    state.status === "ready" &&
    registration?.status === "active" &&
    preferences.enabled;
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      Alert.alert(
        "Notifications unavailable",
        error instanceof Error ? error.message : "Could not update notifications.",
      );
    } finally {
      setBusy(false);
      refreshPermission();
    }
  };
  const subtitle =
    state.status === "registering"
      ? "Waiting for device confirmation"
      : state.status === "failed"
        ? "Could not connect. Turn on to retry."
        : !permitted
          ? "This connection cannot manage notification registrations"
          : undefined;

  return (
    <SettingsSection title={connection.environmentLabel}>
      <SettingsSwitchRow
        label="Notifications"
        icon="bell"
        value={enabled}
        disabled={busy || !permitted}
        subtitle={subtitle}
        onValueChange={(value) => {
          void perform(async () => {
            if (value) await enablePushRegistration(environmentId);
            else await disablePushRegistration(environmentId);
          });
        }}
      />
      {enabled
        ? Object.entries(KIND_LABELS).map(([kind, label]) => (
            <SettingsSwitchRow
              key={kind}
              label={label}
              value={preferences[kind as PushNotificationKind]}
              disabled={busy || !permitted}
              onValueChange={(value) => {
                void perform(() => updatePushPreferences(environmentId, { [kind]: value }));
              }}
            />
          ))
        : null}
      {PushPreview !== null ? (
        <SettingsSwitchRow
          label="Show previews"
          value={preferences.previews}
          subtitle="Show thread names and messages, decrypted only on this device."
          disabled={busy || !permitted || !enabled}
          onValueChange={(value) => {
            void perform(() => updatePushPreferences(environmentId, { previews: value }));
          }}
        />
      ) : null}
      {state.status === "registering" || state.status === "failed" ? (
        <SettingsRow
          icon="arrow.clockwise"
          label="Retry registration"
          disabled={busy || !permitted}
          onPress={() => {
            void perform(() => refreshPushRegistration(environmentId, true));
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
