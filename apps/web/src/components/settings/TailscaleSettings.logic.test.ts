import { describe, expect, it } from "vite-plus/test";

import {
  isTailnetOrigin,
  parseTailnetTagsInput,
  secureTailnetAddressFor,
  tailnetAccountSummary,
  tailnetHostnameError,
  tailnetKeyExpiryDays,
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
