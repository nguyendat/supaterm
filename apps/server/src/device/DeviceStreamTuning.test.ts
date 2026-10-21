import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID, type DeviceHostId } from "@supaterm/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceStreamTuning from "./DeviceStreamTuning.ts";

const SETTINGS_URL = "http://hub.test/vendor/serve-sim/helper/udid-1/stream-settings";
const HUB_SETTINGS = {
  mjpegFps: 60,
  mjpegQuality: 0.7,
  maxDimension: 0,
  h264Bitrate: 6_000_000,
  h264Fps: 60,
};

const makeTuning = (upstream?: DeviceHost.DeviceHostReady["upstream"]) =>
  Effect.gen(function* () {
    const requests: Array<{
      readonly method: string;
      readonly url: string;
      readonly body?: unknown;
    }> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;
        requests.push({ method: request.method, url: request.url, ...(body ? { body } : {}) });
        return HttpClientResponse.fromWeb(request, Response.json(body ?? HUB_SETTINGS));
      }),
    );
    const services = yield* Layer.build(
      DeviceStreamTuning.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(
          Layer.succeed(DeviceService.DeviceService, {
            currentReadiness: () =>
              Effect.succeed({
                hostId: LOCAL_DEVICE_HOST_ID,
                hub: { origin: "http://hub.test" },
                ...(upstream ? { upstream } : {}),
              }),
          } as DeviceService.DeviceService["Service"]),
        ),
      ),
    );
    const tuning = Context.get(services, DeviceStreamTuning.DeviceStreamTuning);
    const watch = Effect.fn(function* (displayEdge: number | null, deviceId = "udid-1") {
      const scope = yield* Scope.make();
      yield* tuning
        .watch({ hostId: LOCAL_DEVICE_HOST_ID as DeviceHostId, deviceId, displayEdge })
        .pipe(Scope.provide(scope));
      return Scope.close(scope, Exit.void);
    });
    return { requests, watch };
  });

const settle = TestClock.adjust("1 second");

it.effect("sizes the encoder for the largest viewer and restores the hub's settings after", () =>
  Effect.gen(function* () {
    const { requests, watch } = yield* makeTuning();
    const leavePanel = yield* watch(1712);
    yield* settle;
    expect(requests).toEqual([
      { method: "GET", url: SETTINGS_URL },
      { method: "PATCH", url: SETTINGS_URL, body: { maxDimension: 1920, h264Bitrate: 3_500_000 } },
    ]);

    const leaveMiniPlayer = yield* watch(900);
    yield* settle;
    expect(requests).toHaveLength(2);

    yield* leavePanel;
    yield* settle;
    expect(requests[2]).toEqual({
      method: "PATCH",
      url: SETTINGS_URL,
      body: { maxDimension: 960, h264Bitrate: 1_000_000 },
    });

    yield* leaveMiniPlayer;
    yield* settle;
    expect(requests[3]).toEqual({
      method: "PATCH",
      url: SETTINGS_URL,
      body: { maxDimension: 0, h264Bitrate: 6_000_000 },
    });
    expect(requests).toHaveLength(4);
  }).pipe(Effect.scoped),
);

it.effect("keeps the hub's settings while any viewer has not reported its size", () =>
  Effect.gen(function* () {
    const { requests, watch } = yield* makeTuning();
    const leaveSized = yield* watch(1200);
    yield* settle;
    expect(requests).toHaveLength(2);

    const leaveUnsized = yield* watch(null);
    yield* settle;
    expect(requests[2]).toEqual({
      method: "PATCH",
      url: SETTINGS_URL,
      body: { maxDimension: 0, h264Bitrate: 6_000_000 },
    });
    yield* leaveSized;
    yield* settle;
    expect(requests).toHaveLength(3);

    yield* leaveUnsized;
    yield* settle;
    expect(requests).toHaveLength(3);
  }).pipe(Effect.scoped),
);

it.effect("waits for viewers to settle before changing anything", () =>
  Effect.gen(function* () {
    const { requests, watch } = yield* makeTuning();
    const leave = yield* watch(1712);
    yield* TestClock.adjust("500 millis");
    yield* leave;
    yield* settle;
    expect(requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("leaves hosts that route their own streams alone", () =>
  Effect.gen(function* () {
    const { requests, watch } = yield* makeTuning(() => Effect.succeed(null));
    const leave = yield* watch(1712);
    yield* settle;
    yield* leave;
    yield* settle;
    expect(requests).toEqual([]);
  }).pipe(Effect.scoped),
);
