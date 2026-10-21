import type { ServerDirectEndpoint } from "@supaterm/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface TailnetExposureState {
  readonly serving: boolean;
  readonly endpoints: ReadonlyArray<ServerDirectEndpoint>;
}

const NOT_SERVING: TailnetExposureState = { serving: false, endpoints: [] };

/**
 * What the built-in tailnet node currently publishes. Auth policy and direct endpoints read
 * this instead of the node itself so CLI runtimes, which never run a node, need not build one.
 */
export class TailnetExposure extends Context.Reference<{
  readonly current: Effect.Effect<TailnetExposureState>;
  readonly changes: Stream.Stream<TailnetExposureState>;
}>("supaterm/tailnet/TailnetExposure", {
  defaultValue: () => ({
    current: Effect.succeed(NOT_SERVING),
    changes: Stream.make(NOT_SERVING),
  }),
}) {}
