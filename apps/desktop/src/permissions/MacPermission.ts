export const MAC_PERMISSION_SETTINGS_URLS = {
  "input-monitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
};

export type MacPermission = keyof typeof MAC_PERMISSION_SETTINGS_URLS;

export const MAC_PERMISSION_TITLES: Record<MacPermission, string> = {
  "input-monitoring": "Input Monitoring",
  "screen-recording": "Screen Recording",
  accessibility: "Accessibility",
  "full-disk-access": "Full Disk Access",
};
