import { describe, expect, it } from "vite-plus/test";
import { AuthStandardClientScopes, sessionGrantsScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import { normalizePushGatewayUrl } from "./push.ts";

describe("device notification permissions", () => {
  it.each([
    WS_METHODS.pushRegister,
    WS_METHODS.pushConfirm,
    WS_METHODS.pushPreferences,
    WS_METHODS.pushRevoke,
    WS_METHODS.pushPresence,
  ])("allows ordinary paired clients to manage their device through %s", (method) => {
    const scopes = clientRpcRequiredScopes(method, {});
    expect(scopes.length).toBe(1);
    expect(
      scopes.every((scope) =>
        sessionGrantsScope({ authenticated: true, permissions: AuthStandardClientScopes }, scope),
      ),
    ).toBe(true);
    expect(
      scopes.every((scope) =>
        sessionGrantsScope({ authenticated: true, permissions: ["orchestration:read"] }, scope),
      ),
    ).toBe(false);
  });
  it("accepts HTTPS and isolated loopback gateways without credential-bearing URLs", () => {
    expect(normalizePushGatewayUrl(" https://push.supacode.sh/ ")).toBe("https://push.supacode.sh");
    expect(normalizePushGatewayUrl("http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
    for (const url of [
      "http://remote.test",
      "https://secret@push.supacode.sh",
      "https://push.supacode.sh/path",
      "https://push.supacode.sh?token=secret",
    ])
      expect(normalizePushGatewayUrl(url)).toBeNull();
  });
});
