import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@supaterm/contracts";

import { CONNECTION_STATUS_DELAY_MS } from "./status-delay";
import { createDelayedEnvironmentConnectionVisibility } from "./delayed-environment-connections";

const connected = {
  environmentId: EnvironmentId.make("environment-1"),
  connectionState: "connected",
} as const;
const reconnecting = { ...connected, connectionState: "reconnecting" } as const;

describe("delayed environment connection visibility controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a connected environment visible through a quick reconnect", () => {
    const changes: ReadonlySet<typeof connected.environmentId>[] = [];
    const visibility = createDelayedEnvironmentConnectionVisibility((next) => changes.push(next));

    visibility.update([connected], true);
    visibility.update([reconnecting], true);
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS - 1);
    expect(changes.at(-1)).toEqual(new Set([connected.environmentId]));
    vi.advanceTimersByTime(1);
    expect(changes.at(-1)).toEqual(new Set());
    visibility.dispose();
  });

  it("cancels the delay when the connection returns", () => {
    const changes: ReadonlySet<typeof connected.environmentId>[] = [];
    const visibility = createDelayedEnvironmentConnectionVisibility((next) => changes.push(next));

    visibility.update([connected], true);
    visibility.update([reconnecting], true);
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS - 1);
    visibility.update([connected], true);
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changes.at(-1)).toEqual(new Set([connected.environmentId]));
    visibility.dispose();
  });

  it("shows non-retryable connection states immediately", () => {
    const changes: ReadonlySet<typeof connected.environmentId>[] = [];
    const visibility = createDelayedEnvironmentConnectionVisibility((next) => changes.push(next));

    visibility.update([connected], true);
    visibility.update([{ ...connected, connectionState: "offline" }], true);
    expect(changes.at(-1)).toEqual(new Set());
    visibility.dispose();
  });

  it("does not expire cached visibility while the app is inactive", () => {
    const changes: ReadonlySet<typeof connected.environmentId>[] = [];
    const visibility = createDelayedEnvironmentConnectionVisibility((next) => changes.push(next));

    visibility.update([connected], true);
    visibility.update([reconnecting], false);
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changes.at(-1)).toEqual(new Set([connected.environmentId]));
    visibility.dispose();
  });

  it("restarts the delay after returning from the background", () => {
    const changes: ReadonlySet<typeof connected.environmentId>[] = [];
    const visibility = createDelayedEnvironmentConnectionVisibility((next) => changes.push(next));

    visibility.update([connected], true);
    visibility.update([reconnecting], true);
    vi.advanceTimersByTime(500);
    visibility.update([reconnecting], false);
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS);
    expect(changes.at(-1)).toEqual(new Set([connected.environmentId]));
    visibility.update([reconnecting], true);
    vi.advanceTimersByTime(CONNECTION_STATUS_DELAY_MS - 1);
    expect(changes.at(-1)).toEqual(new Set([connected.environmentId]));
    vi.advanceTimersByTime(1);
    expect(changes.at(-1)).toEqual(new Set());
    visibility.dispose();
  });
});
