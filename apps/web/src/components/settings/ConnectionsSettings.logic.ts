import {
  type AdvertisedEndpoint,
  type AuthGrantScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type DesktopBridge,
  type DesktopWslState,
  type RelayConnectionInfo,
  type ServerSettings,
  type ServerDirectEndpoint,
  normalizeRelayServerUrl,
} from "@supacode/contracts";
import {
  createAdvertisedEndpoint,
  normalizeHttpBaseUrl,
} from "@supacode/shared/advertisedEndpoint";
import type { PairingRouteHints } from "@supacode/shared/remote";
import { isQrShareablePairingUrl } from "./pairingUrls";

export function mergeServerPairingEndpoints(
  advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint>,
  directEndpoints: ReadonlyArray<ServerDirectEndpoint>,
): ReadonlyArray<AdvertisedEndpoint> {
  const endpoints = [...advertisedEndpoints];
  for (const direct of directEndpoints) {
    if (!isQrShareablePairingUrl(direct.httpBaseUrl)) continue;
    const httpBaseUrl = normalizeHttpBaseUrl(direct.httpBaseUrl);
    if (
      endpoints.some(
        (endpoint) => endpoint.status !== "unavailable" && endpoint.httpBaseUrl === httpBaseUrl,
      )
    )
      continue;
    const tailnet = direct.kind === "tailnet";
    const label = tailnet ? "Tailscale" : "Local network";
    endpoints.push(
      createAdvertisedEndpoint({
        id: `server-direct:${httpBaseUrl}`,
        label,
        provider: {
          id: tailnet ? "server-tailnet" : "server-lan",
          label,
          kind: tailnet ? "private-network" : "core",
          isAddon: false,
        },
        httpBaseUrl,
        reachability: tailnet ? "private-network" : "lan",
        hostedHttpsCompatibility:
          new URL(httpBaseUrl).protocol === "https:" ? "compatible" : "mixed-content-blocked",
        source: "server",
      }),
    );
  }
  return endpoints;
}

export function createRelayPairingEndpoint(relayEndpoint: string) {
  return createAdvertisedEndpoint({
    id: "public-relay",
    label: "Public relay",
    provider: { id: "public-relay", label: "Public relay", kind: "tunnel", isAddon: false },
    httpBaseUrl: relayEndpoint,
    reachability: "public",
    hostedHttpsCompatibility: "compatible",
    source: "server",
    description: "End-to-end encrypted access through the public relay.",
  });
}

export function resolvePairingLinkRoutes(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  pairingHints: PairingRouteHints,
  relay: RelayConnectionInfo | undefined,
  settings: Pick<ServerSettings, "publicRelayEnabled" | "publicRelayUrl"> | undefined,
) {
  if (
    relay === undefined ||
    endpoints.some((endpoint) => endpoint.id === "public-relay") ||
    !settings?.publicRelayEnabled ||
    normalizeRelayServerUrl(settings.publicRelayUrl) !== relay.relayUrl
  )
    return { endpoints, pairingHints };
  return {
    endpoints: [...endpoints, createRelayPairingEndpoint(relay.relayEndpoint)],
    pairingHints: { ...pairingHints, relayUrl: relay.relayUrl },
  };
}

/**
 * Operating terminals without being able to list them leaves a client
 * allocating a fresh shell for every script run it cannot see, so the pairing
 * form keeps `terminal:read` alongside `terminal:operate`.
 */
export function togglePairingScopeSelection(
  current: ReadonlyArray<AuthGrantScope>,
  scope: AuthGrantScope,
  checked: boolean,
): ReadonlyArray<AuthGrantScope> {
  const without = (scopes: ReadonlyArray<AuthGrantScope>) =>
    scopes.filter((currentScope) => currentScope !== scope);
  if (!checked) {
    return scope === AuthTerminalReadScope
      ? without(current).filter((currentScope) => currentScope !== AuthTerminalOperateScope)
      : without(current);
  }
  const next = [...without(current), scope];
  return scope === AuthTerminalOperateScope && !next.includes(AuthTerminalReadScope)
    ? [...next, AuthTerminalReadScope]
    : next;
}

/** A missing access list says nothing about whether other clients exist. */
export function canRevokeOtherClients(
  clientSessions: ReadonlyArray<{ readonly current: boolean }> | null,
): boolean {
  return clientSessions === null || clientSessions.some((session) => !session.current);
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

export type QrEndpointOption = {
  /** Unique per endpoint instance (AdvertisedEndpoint.id); safe as a React key. */
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  /** False for endpoints that stay copyable but must never render as a QR. */
  readonly qrShareable: boolean;
};

/**
 * Resolves which endpoint the share panel shows: the user's explicit pick,
 * else the saved default endpoint, else the first QR-shareable option (so the
 * panel never opens on a loopback QR), else the first option. A stale
 * selectedId (endpoint disappeared) falls back rather than blanking the panel.
 */
export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
