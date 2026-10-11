import { buildHostedPairingUrl } from "../../hostedPairing";
import { buildPairingUrl, type PairingRouteHints } from "@supacode/shared/remote";
import { isLoopbackHostname } from "../../environments/primary/target";

export function isQrShareablePairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const endpoint = new URL(url.searchParams.get("host") ?? url.href);
    return (
      (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      !isLoopbackHostname(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

export function resolvePairingShareValue(
  credential: string,
  endpointUrl: string | null | undefined,
  hints: PairingRouteHints = {},
  hostedPairingAllowed = true,
) {
  if (!endpointUrl) return { value: credential, kind: "code" as const, qrShareable: false };
  const endpoint = new URL(endpointUrl);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    return { value: credential, kind: "code" as const, qrShareable: false };
  return {
    value:
      (hostedPairingAllowed ? resolveHostedPairingUrl(endpointUrl, credential, hints) : null) ??
      resolveDesktopPairingUrl(endpointUrl, credential, hints),
    kind: "link" as const,
    qrShareable: isQrShareablePairingUrl(endpointUrl),
  };
}

export function resolveShareablePairingUrl(
  credential: string,
  endpointUrl: string | null | undefined,
  hints: PairingRouteHints = {},
  hostedPairingAllowed = true,
): string | null {
  const result = resolvePairingShareValue(credential, endpointUrl, hints, hostedPairingAllowed);
  return result.qrShareable ? result.value : null;
}

export function resolveDesktopPairingUrl(
  endpointUrl: string,
  credential: string,
  hints: PairingRouteHints = {},
): string {
  return buildPairingUrl(endpointUrl, credential, hints);
}

export function resolveHostedPairingUrl(
  endpointUrl: string,
  credential: string,
  hints: PairingRouteHints = {},
): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
    ...hints,
  });
}
