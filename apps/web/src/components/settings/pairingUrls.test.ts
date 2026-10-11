import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@supacode/contracts";
import { resolveRemotePairingTarget } from "@supacode/shared/remote";

import {
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
  resolvePairingShareValue,
  resolveShareablePairingUrl,
  isQrShareablePairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it.each(["http://192.168.1.44:3773", "https://machine.ts.net"])(
    "uses the server origin without carrying page queries into pairing: %s",
    (host) => {
      const result = resolvePairingShareValue(
        "PAIRCODE",
        `${host}/settings/connections?host=https://unrelated.invalid#token=OLD`,
      );
      expect(resolveRemotePairingTarget({ pairingUrl: result.value })).toMatchObject({
        httpBaseUrl: `${host}/`,
        credential: "PAIRCODE",
      });
      expect(result.value).not.toContain("unrelated.invalid");
    },
  );

  it("does not make a loopback endpoint shareable through a page host query", () => {
    const endpoint = "http://127.0.0.1:3773/settings/connections?host=https://unrelated.invalid";
    const result = resolvePairingShareValue("PAIRCODE", endpoint);
    expect(result.qrShareable).toBe(false);
    expect(resolveShareablePairingUrl("PAIRCODE", endpoint)).toBeNull();
    expect(result.value).not.toContain("unrelated.invalid");
  });
  it.each([
    "supacode://app/pair#token=PAIRCODE&env=machine",
    "file:///Applications/Supacode/index.html",
    "http://localhost:3773/pair#token=PAIRCODE",
    "http://127.0.0.1:3773/pair#token=PAIRCODE",
    "http://[::1]:3773/pair#token=PAIRCODE",
    "https://app.next.supacode.sh/pair?host=http%3A%2F%2F127.0.0.1%3A3773#token=PAIRCODE",
    "https://app.next.supacode.sh/pair?host=supacode%3A%2F%2Fapp#token=PAIRCODE",
    "https://app.next.supacode.sh/pair?host=invalid#token=PAIRCODE",
    "PAIRCODE",
  ])("does not offer a QR for an unreachable pairing URL: %s", (url) => {
    expect(isQrShareablePairingUrl(url)).toBe(false);
  });

  it.each([
    "supacode://app/",
    "file:///Applications/Supacode/index.html",
    "http://localhost:3773",
    "http://127.0.0.1:3773",
    "http://[::1]:3773",
    null,
  ])("does not offer a default sharing link without a remote endpoint: %s", (endpoint) => {
    expect(resolveShareablePairingUrl("PAIRCODE", endpoint)).toBeNull();
  });

  it.each(["http://192.168.1.44:3773", "https://machine.ts.net"])(
    "keeps a reachable endpoint shareable: %s",
    (host) => {
      const url = resolveShareablePairingUrl("PAIRCODE", host, {
        environmentId: EnvironmentId.make("machine"),
      });
      expect(url).not.toBeNull();
      expect(isQrShareablePairingUrl(url!)).toBe(true);
      expect(resolveRemotePairingTarget({ pairingUrl: url! })).toMatchObject({
        credential: "PAIRCODE",
        httpBaseUrl: `${host}/`,
        environmentId: "machine",
      });
    },
  );

  it.each(["supacode://app", "file:///Applications/Supacode/index.html"])(
    "shows the code instead of creating a remote link from %s",
    (origin) => {
      expect(resolvePairingShareValue("PAIRCODE", origin)).toEqual({
        value: "PAIRCODE",
        kind: "code",
        qrShareable: false,
      });
    },
  );
  it("keeps incompatible HTTPS endpoints on the direct pairing route", () => {
    const result = resolvePairingShareValue("PAIRCODE", "https://private-host.invalid", {}, false);
    expect(result.value).toBe("https://private-host.invalid/pair#token=PAIRCODE");
    expect(result.qrShareable).toBe(true);
  });
  it("shows a relay link and a scannable QR before access-list updates arrive", () => {
    const relayUrl = "wss://custom-relay.invalid";
    const host = `https://${"11".repeat(16)}.${"22".repeat(16)}.relay.supacode.invalid/`;
    const result = resolvePairingShareValue("PAIRCODE", host, {
      environmentId: EnvironmentId.make("machine"),
      relayUrl,
    });
    expect(result.kind).toBe("link");
    expect(result.qrShareable).toBe(true);
    expect(
      resolveShareablePairingUrl("PAIRCODE", host, {
        environmentId: EnvironmentId.make("machine"),
        relayUrl,
      }),
    ).toBe(result.value);
    expect(isQrShareablePairingUrl(result.value)).toBe(true);
    expect(resolveRemotePairingTarget({ pairingUrl: result.value })).toMatchObject({
      credential: "PAIRCODE",
      httpBaseUrl: host,
      relayUrl,
      environmentId: "machine",
    });
  });

  it("shows the creation credential when no reachable URL is available", () => {
    expect(resolvePairingShareValue("PAIRCODE", null)).toEqual({
      value: "PAIRCODE",
      kind: "code",
      qrShareable: false,
    });
  });

  it.each(["http://localhost:3773", "http://127.0.0.1:3773", "http://[::1]:3773"])(
    "keeps %s copyable without offering a QR that would dial the scanning device",
    (origin) => {
      const result = resolvePairingShareValue("PAIRCODE", origin);
      expect(result.kind).toBe("link");
      expect(result.qrShareable).toBe(false);
      expect(result.value).toContain("#token=PAIRCODE");
    },
  );
  it("carries the same identity and routes through direct and hosted links", () => {
    const hints = {
      environmentId: EnvironmentId.make("machine"),
      routes: ["https://machine.ts.net", "http://100.64.1.2:3773"],
    };
    for (const pairingUrl of [
      resolveDesktopPairingUrl("https://public.test", "code", hints),
      resolveHostedPairingUrl("https://public.test", "code", hints),
    ]) {
      expect(resolveRemotePairingTarget({ pairingUrl: pairingUrl! })).toMatchObject({
        environmentId: hints.environmentId,
        routes: ["https://machine.ts.net/", "http://100.64.1.2:3773/"],
      });
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.next.supacode.sh");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.next.supacode.sh/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});
