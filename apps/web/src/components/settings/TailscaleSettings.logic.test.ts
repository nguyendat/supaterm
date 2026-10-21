import { describe, expect, it } from "vite-plus/test";

import type { TailnetStatus } from "@supaterm/contracts";

import {
  type TailnetOperation,
  type TailnetOperationKind,
  activeTailnetOperation,
  canStartTailnetOperation,
  isTailnetOrigin,
  parseTailnetTagsInput,
  secureTailnetAddressFor,
  tailnetAccountSummary,
  tailnetHostnameError,
  tailnetKeyExpiryDays,
  tailnetStatusHeader,
} from "./TailscaleSettings.logic";

const urls = { httpsUrl: "https://host.tailnet.ts.net/", httpUrl: "http://100.64.0.7/" };

describe("parseTailnetTagsInput", () => {
  it("accepts comma or space separated tags and drops duplicates", () => {
    expect(parseTailnetTagsInput(" tag:server, tag:ci  tag:server,")).toEqual({
      tags: ["tag:server", "tag:ci"],
      invalid: [],
    });
  });

  it("reports entries control would reject", () => {
    expect(parseTailnetTagsInput("tag:ok server tag:9lives").invalid).toEqual([
      "server",
      "tag:9lives",
    ]);
  });
});

describe("tailnetHostnameError", () => {
  it("accepts a DNS label and explains anything else", () => {
    expect(tailnetHostnameError("khoi-jqrp62g46r-supaterm")).toBeNull();
    expect(tailnetHostnameError("")).toBe("Enter a hostname.");
    expect(tailnetHostnameError("My Mac")).not.toBeNull();
    expect(tailnetHostnameError("-leading")).not.toBeNull();
  });
});

describe("tailnetAccountSummary", () => {
  it("names the account, or the tags for a tagged device", () => {
    expect(tailnetAccountSummary({ tagged: false, tags: [], loginName: "khoi@github" })).toBe(
      "Signed in as khoi@github",
    );
    expect(tailnetAccountSummary({ tagged: true, tags: ["tag:server", "tag:ci"] })).toBe(
      "Tagged device · tag:server, tag:ci",
    );
    expect(tailnetAccountSummary(undefined)).toBeNull();
  });
});

describe("isTailnetOrigin", () => {
  it("matches the page origin against either tailnet address", () => {
    expect(isTailnetOrigin("https://host.tailnet.ts.net", urls)).toBe(true);
    expect(isTailnetOrigin("http://100.64.0.7", urls)).toBe(true);
    expect(isTailnetOrigin("http://localhost:5733", urls)).toBe(false);
    expect(isTailnetOrigin("http://100.64.0.7", {})).toBe(false);
  });
});

describe("secureTailnetAddressFor", () => {
  it("points a plain-HTTP tailnet page at the HTTPS address", () => {
    expect(
      secureTailnetAddressFor({
        origin: "http://100.64.0.7",
        isSecureContext: false,
        status: urls,
      }),
    ).toBe(urls.httpsUrl);
  });

  it("stays quiet on secure pages, other origins, or without an HTTPS address", () => {
    const base = { origin: "http://100.64.0.7", isSecureContext: false, status: urls };
    expect(secureTailnetAddressFor({ ...base, isSecureContext: true })).toBeNull();
    expect(secureTailnetAddressFor({ ...base, origin: "http://192.168.1.4:3773" })).toBeNull();
    expect(secureTailnetAddressFor({ ...base, status: { httpUrl: urls.httpUrl } })).toBeNull();
  });
});

describe("tailnetKeyExpiryDays", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("warns within two weeks of expiry", () => {
    expect(tailnetKeyExpiryDays("2026-10-24T12:00:00Z", now)).toBe(3);
    expect(tailnetKeyExpiryDays("2026-10-21T18:00:00Z", now)).toBe(1);
  });

  it("stays quiet far from expiry, after it, or without a key expiry", () => {
    expect(tailnetKeyExpiryDays("2027-04-01T00:00:00Z", now)).toBeNull();
    expect(tailnetKeyExpiryDays("2026-10-01T00:00:00Z", now)).toBeNull();
    expect(tailnetKeyExpiryDays(undefined, now)).toBeNull();
  });
});

describe("canStartTailnetOperation", () => {
  const kinds: ReadonlyArray<TailnetOperationKind> = [
    "sign-in",
    "cancel-sign-in",
    "reauthenticate",
    "sign-out",
    "configure",
  ];
  const startable = (active: TailnetOperation | null) =>
    kinds.filter((kind) => canStartTailnetOperation(active, kind));

  it("allows any operation while idle", () => {
    expect(startable(null)).toEqual(kinds);
  });

  it("only lets a cancel interrupt a waiting sign-in", () => {
    expect(startable({ kind: "sign-in" })).toEqual(["cancel-sign-in"]);
  });

  it("blocks everything while any other operation runs", () => {
    expect(startable({ kind: "cancel-sign-in" })).toEqual([]);
    expect(startable({ kind: "sign-out" })).toEqual([]);
    expect(startable({ kind: "reauthenticate" })).toEqual([]);
    expect(startable({ kind: "configure", patch: { serveEnabled: false } })).toEqual([]);
  });
});

describe("activeTailnetOperation", () => {
  it("hands control back to a sign-in that outlives the cancel interrupting it", () => {
    const signIn: TailnetOperation = { kind: "sign-in" };
    const cancel: TailnetOperation = { kind: "cancel-sign-in" };
    expect(activeTailnetOperation([])).toBeNull();
    expect(activeTailnetOperation([signIn, cancel])).toBe(cancel);
    expect(activeTailnetOperation([signIn])).toBe(signIn);
  });
});

describe("tailnetStatusHeader", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const status = (overrides: Partial<TailnetStatus>): TailnetStatus => ({
    phase: "signed-out",
    suggestedHostname: "khoi-mac",
    tags: [],
    serveEnabled: true,
    requireOwner: true,
    loggingAllowed: false,
    loggingRequired: false,
    https: "pending",
    ...overrides,
  });

  it("offers the account actions each phase supports", () => {
    const actions = (phase: TailnetStatus["phase"]) =>
      tailnetStatusHeader(status({ phase }), "this Mac", now).actions;
    expect(actions("unavailable")).toEqual([]);
    expect(actions("signed-out")).toEqual(["sign-in"]);
    expect(actions("needs-login")).toEqual(["cancel-sign-in", "continue"]);
    expect(actions("needs-approval")).toEqual(["cancel-sign-in"]);
    expect(actions("needs-reauth")).toEqual(["sign-out", "reauthenticate"]);
    expect(actions("running")).toEqual(["sign-out"]);
    expect(actions("error")).toEqual(["sign-out"]);
  });

  it("warns while reauthentication is needed and when the key nears expiry", () => {
    expect(tailnetStatusHeader(status({ phase: "needs-reauth" }), "this Mac", now).warning).toBe(
      "Supaterm isn't reachable over Tailscale until you reauthenticate.",
    );
    const running = (keyExpiry: string) =>
      tailnetStatusHeader(
        status({ phase: "running", self: { tagged: false, tags: [], keyExpiry } }),
        "this Mac",
        now,
      );
    expect(running("2026-10-22T12:00:00Z").warning).toMatch(/expires in 1 day\./u);
    expect(running("2027-04-01T00:00:00Z").warning).toBeUndefined();
  });

  it("shows a failed change while running so the user can retry it", () => {
    const header = tailnetStatusHeader(
      status({
        phase: "running",
        message: "Could not rename this machine on Tailscale: name taken",
        self: { tagged: false, tags: [], keyExpiry: "2026-10-22T12:00:00Z" },
      }),
      "this Mac",
      now,
    );
    expect(header.warning).toBe("Could not rename this machine on Tailscale: name taken");
  });
});
