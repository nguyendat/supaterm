/** Credentials for media requests that cannot set bearer headers. */
export interface DeviceHubAccess {
  /** Absolute environment URL ending in `/api/device-hub`. */
  readonly httpBase: string;
  /** Same base with the `ws(s)` scheme. */
  readonly wsBase: string;
  readonly mediaV1WsBase?: string;
  /** Empty for cookie sessions; includes a short-lived ticket for bearer sessions. */
  readonly query: Readonly<Record<string, string>>;
  /** Whether requests must include session cookies. */
  readonly credentials: boolean;
}

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};
