import { useState } from "react";
import { normalizePushGatewayUrl } from "@supaterm/contracts/push";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          "System alerts when a thread finishes, fails, or needs you. This device only."
        }
        control={
          <Select
            value={mode}
            disabled={requesting}
            onValueChange={async (value) => {
              if (
                value !== "off" &&
                value !== "notifications" &&
                value !== "sound" &&
                value !== "notifications-and-sound"
              )
                return;
              setPermissionMessage(null);
              if (hasNotificationSound(value)) unlockNotificationAudio();
              if (hasDesktopNotifications(value)) {
                if (typeof Notification === "undefined" || !window.isSecureContext) {
                  setPermissionMessage(
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  );
                  return;
                }
                setRequesting(true);
                try {
                  const permission = await Notification.requestPermission();
                  if (permission !== "granted") {
                    setPermissionMessage(
                      "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                    );
                    return;
                  }
                } catch {
                  setPermissionMessage(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  );
                  return;
                } finally {
                  setRequesting(false);
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <PushGatewaySettings />
    </>
  );
}

function PushGatewaySettings() {
  const url = useScopedSettings((settings) => settings.pushGatewayUrl);
  const allowed = useScopedSettingsWriteAllowed();
  const update = useUpdateScopedSettings();
  const [edit, setEdit] = useState<{ readonly url: typeof url; readonly draft: string } | null>(
    null,
  );
  const draft = edit?.url === url ? edit.draft : (url ?? "");
  const [invalid, setInvalid] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("push-gateway")}
      serverScoped
      settingKeys={["pushGatewayUrl"]}
      description={
        invalid
          ? "Enter an HTTPS address, or leave empty to disable push delivery."
          : "Delivers iOS notifications for this environment. Devices opt in from their notification settings."
      }
      control={
        <div className="w-full sm:w-72">
          <Input
            size="sm"
            font="mono"
            aria-label="Push gateway"
            value={draft}
            disabled={!allowed}
            placeholder="Disabled"
            onValueChange={(draft) => {
              setEdit({ url, draft });
              setInvalid(false);
            }}
            onBlur={() => {
              const value = draft.trim() === "" ? null : normalizePushGatewayUrl(draft);
              if (value === null && draft.trim() !== "") {
                setInvalid(true);
                return;
              }
              setInvalid(false);
              if (value !== url) update({ pushGatewayUrl: value });
            }}
          />
        </div>
      }
    />
  );
}
