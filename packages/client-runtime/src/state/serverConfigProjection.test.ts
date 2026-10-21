import type { ServerConfig, ServerConfigStreamEvent } from "@supaterm/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("returns the previous value when nothing changed", () => {
    const previous = [provider("a", ["x"])];
    expect(reuseUnchanged(previous, [provider("a", ["x"])])).toBe(previous);
  });

  it("keeps unchanged parts when one field changes", () => {
    const previous = [provider("a", ["x"]), { ...provider("a", ["y"]), instanceId: "codex" }];
    const next = reuseUnchanged(previous, [
      provider("b", ["x"]),
      { ...provider("a", ["y"]), instanceId: "codex" },
    ]);
    expect(next).not.toBe(previous);
    expect(next[0]).not.toBe(previous[0]);
    expect(next[0]!.checkedAt).toBe("b");
    expect(next[0]!.models).toBe(previous[0]!.models);
    expect(next[0]!.skills).toBe(previous[0]!.skills);
    expect(next[1]).toBe(previous[1]);
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});

describe("applyServerConfigProjection snapshot", () => {
  const snapshot = (checkedAt: string) =>
    ({
      type: "snapshot",
      config: {
        environment: { capabilities: {} },
        providers: [{ instanceId: "claude", checkedAt, skills: [{ name: "review" }] }],
      },
    }) as unknown as ServerConfigStreamEvent;
  const providersOf = (projection: ReturnType<typeof applyServerConfigProjection>) =>
    (Option.getOrThrow(projection).config as ServerConfig).providers;

  it("keeps unchanged skills when a reconnect re-sends the config", () => {
    const first = applyServerConfigProjection(Option.none(), snapshot("a"));
    const second = applyServerConfigProjection(first, snapshot("b"));
    expect(providersOf(second)[0]!.checkedAt).toBe("b");
    expect(providersOf(second)[0]!.skills).toBe(providersOf(first)[0]!.skills);
  });
});

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });
});

describe("applyServerConfigProjection reachabilityUpdated", () => {
  const lan = { kind: "lan", httpBaseUrl: "http://192.168.1.4:3773" } as const;
  const tailnet = { kind: "tailnet", httpBaseUrl: "https://host.tailnet.ts.net/" } as const;
  const auth = (policy: string) => ({
    policy,
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "supaterm_session",
  });
  const current = Option.some({
    config: {
      auth: auth("loopback-browser"),
      directEndpoints: [lan],
      settings: { favorites: [] },
    } as unknown as ServerConfig,
    latestEvent: {} as ServerConfigStreamEvent,
    source: "live" as const,
  });
  const reachability = (policy: string, directEndpoints: ReadonlyArray<unknown>) =>
    ({
      version: 1,
      type: "reachabilityUpdated",
      payload: { auth: auth(policy), directEndpoints },
    }) as unknown as ServerConfigStreamEvent;

  it("merges learned routes and the auth policy without touching the rest of the config", () => {
    const next = Option.getOrThrow(
      applyServerConfigProjection(current, reachability("remote-reachable", [tailnet, lan])),
    );
    const before = Option.getOrThrow(current).config;
    expect(next.config.auth.policy).toBe("remote-reachable");
    expect(next.config.directEndpoints).toEqual([tailnet, lan]);
    expect(next.config.directEndpoints?.[1]).toBe(before.directEndpoints?.[0]);
    expect(next.config.settings).toBe(before.settings);
    expect(next.latestEvent.type).toBe("reachabilityUpdated");
  });

  it("withdraws routes the server stopped advertising", () => {
    const next = Option.getOrThrow(
      applyServerConfigProjection(current, reachability("loopback-browser", [])),
    );
    expect(next.config.directEndpoints).toEqual([]);
    expect(next.config.auth).toBe(Option.getOrThrow(current).config.auth);
  });

  it("waits for a snapshot before applying an update", () => {
    expect(
      Option.isNone(
        applyServerConfigProjection(Option.none(), reachability("remote-reachable", [tailnet])),
      ),
    ).toBe(true);
  });
});
