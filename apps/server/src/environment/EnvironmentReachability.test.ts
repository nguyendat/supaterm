import type {
  ServerAuthDescriptor,
  ServerConfigReachabilityUpdatedPayload,
  ServerDirectEndpoint,
} from "@supaterm/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import { TailnetExposure, type TailnetExposureState } from "../tailnet/TailnetExposure.ts";
import * as DirectEndpoints from "./DirectEndpoints.ts";
import * as EnvironmentReachability from "./EnvironmentReachability.ts";

const local: ServerAuthDescriptor = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-access-token"],
  sessionCookieName: "supaterm_session_3773",
};
const remote: ServerAuthDescriptor = { ...local, policy: "remote-reachable" };

const tailnetEndpoints: ReadonlyArray<ServerDirectEndpoint> = [
  { kind: "tailnet", httpBaseUrl: "https://host.tail1234.ts.net/" },
  { kind: "tailnet", httpBaseUrl: "http://100.64.0.1/" },
];
const notServing: TailnetExposureState = { serving: false, endpoints: [] };
const serving: TailnetExposureState = { serving: true, endpoints: tailnetEndpoints };

const localReachability = { auth: local, directEndpoints: [] };
const servingReachability = { auth: remote, directEndpoints: tailnetEndpoints };

const withReachability = <A, E>(
  resolveFor: DirectEndpoints.DirectEndpoints["Service"]["resolveFor"],
  run: (input: {
    readonly exposure: SubscriptionRef.SubscriptionRef<TailnetExposureState>;
    readonly reachability: EnvironmentReachability.EnvironmentReachability["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const exposure = yield* SubscriptionRef.make(notServing);
    return yield* EnvironmentReachability.EnvironmentReachability.pipe(
      Effect.flatMap((reachability) => run({ exposure, reachability })),
      Effect.provide(
        EnvironmentReachability.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(TailnetExposure, {
                current: SubscriptionRef.get(exposure),
                changes: SubscriptionRef.changes(exposure),
              }),
              Layer.mock(EnvironmentAuthPolicy.EnvironmentAuthPolicy)({
                descriptorFor: (state) => (state.serving ? remote : local),
              }),
              Layer.mock(DirectEndpoints.DirectEndpoints)({ resolveFor }),
            ),
          ),
        ),
      ),
    );
  });

const subscribe = (changes: Stream.Stream<ServerConfigReachabilityUpdatedPayload>) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<ServerConfigReachabilityUpdatedPayload>();
    yield* changes.pipe(
      Stream.runForEach((value) => Queue.offer(received, value)),
      Effect.forkScoped,
    );
    return received;
  });

it.effect("resolves each exposure change once for every subscriber and skips repeats", () => {
  const resolved: Array<TailnetExposureState> = [];
  return withReachability(
    (state) =>
      Effect.sync(() => {
        resolved.push(state);
        return state.endpoints;
      }),
    ({ exposure, reachability }) =>
      Effect.gen(function* () {
        const first = yield* subscribe(reachability.changes);
        const second = yield* subscribe(reachability.changes);
        assert.deepEqual(yield* Queue.take(first), localReachability);
        assert.deepEqual(yield* Queue.take(second), localReachability);

        yield* SubscriptionRef.set(exposure, serving);
        assert.deepEqual(yield* Queue.take(first), servingReachability);
        assert.deepEqual(yield* Queue.take(second), servingReachability);

        yield* SubscriptionRef.set(exposure, { ...serving, endpoints: [...tailnetEndpoints] });
        yield* SubscriptionRef.set(exposure, notServing);
        assert.deepEqual(yield* Queue.take(first), localReachability);
        assert.deepEqual(yield* Queue.take(second), localReachability);

        assert.deepEqual(resolved, [notServing, serving, serving, notServing]);
        assert.deepEqual(yield* reachability.current, localReachability);
      }).pipe(Effect.scoped),
  );
});

it.effect("never lets a resolution that started earlier replace a newer one", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withReachability(
      (state) =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 2) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return state.endpoints;
        }),
      ({ exposure, reachability }) =>
        Effect.gen(function* () {
          const updates = yield* subscribe(reachability.changes);
          assert.deepEqual(yield* Queue.take(updates), localReachability);

          const stale = yield* Effect.forkChild(reachability.current);
          yield* Deferred.await(entered);
          yield* SubscriptionRef.set(exposure, serving);
          assert.deepEqual(yield* Queue.take(updates), servingReachability);

          yield* Deferred.succeed(release, undefined);
          assert.deepEqual(yield* Fiber.join(stale), localReachability);

          const latest = yield* subscribe(reachability.changes);
          assert.deepEqual(yield* Queue.take(latest), servingReachability);
        }).pipe(Effect.scoped),
    );
  });
});
