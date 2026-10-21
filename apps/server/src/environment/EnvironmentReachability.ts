/**
 * EnvironmentReachability - the auth policy and direct endpoints clients use to reach this
 * server. Both change together when the built-in tailnet node starts or stops serving.
 */
import type { ServerConfigReachabilityUpdatedPayload } from "@supaterm/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import { TailnetExposure } from "../tailnet/TailnetExposure.ts";
import * as DirectEndpoints from "./DirectEndpoints.ts";

export class EnvironmentReachability extends Context.Service<
  EnvironmentReachability,
  {
    /** Resolves afresh, so a reconnecting client also sees a LAN address that changed. */
    readonly current: Effect.Effect<ServerConfigReachabilityUpdatedPayload>;
    /** The latest resolution, then each one that differs from it. */
    readonly changes: Stream.Stream<ServerConfigReachabilityUpdatedPayload>;
  }
>()("supaterm/environment/EnvironmentReachability") {}

const make = Effect.gen(function* () {
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
  const tailnet = yield* TailnetExposure;
  const started = yield* Ref.make(0);
  const latest = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly value?: ServerConfigReachabilityUpdatedPayload;
  }>({ sequence: 0 });

  const current = Effect.gen(function* () {
    const sequence = yield* Ref.updateAndGet(started, (count) => count + 1);
    const exposure = yield* tailnet.current;
    const value = {
      auth: policy.descriptorFor(exposure),
      directEndpoints: yield* directEndpoints.resolveFor(exposure),
    };
    // Numbered before the exposure is read, so the highest number saw the newest exposure and
    // network; a slower resolution that started earlier must not replace it.
    yield* SubscriptionRef.update(latest, (published) =>
      sequence > published.sequence ? { sequence, value } : published,
    );
    return value;
  }).pipe(Effect.withSpan("EnvironmentReachability.current"));

  yield* tailnet.changes.pipe(
    Stream.runForEach(() => current),
    Effect.forkScoped,
  );

  return EnvironmentReachability.of({
    current,
    changes: SubscriptionRef.changes(latest).pipe(
      Stream.map((published) => published.value),
      Stream.filter(Predicate.isNotUndefined),
      Stream.changes,
    ),
  });
});

export const layer = Layer.effect(EnvironmentReachability, make);
