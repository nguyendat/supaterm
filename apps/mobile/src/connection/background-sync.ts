import { Connection, HeadlessSync } from "@supacode/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as Runtime from "../lib/runtime";
import * as ConnectionPlatform from "./platform";

// The connection services without their startup: no supervisor connects, and
// the activity reporter that marks this device as a foreground client stays out.
const layerBackgroundSync = HeadlessSync.layer.pipe(
  Layer.provide(Connection.layerServices({})),
  Layer.provide(
    Layer.mergeAll(Runtime.layer, ConnectionPlatform.layer.pipe(Layer.provide(Runtime.layer))),
  ),
);

/**
 * One read-only sync pass for a background execution slot, callable from a
 * native task callback with no React tree mounted. Refreshes the cached shell
 * and recent thread snapshots of every saved environment over HTTP, then tears
 * its runtime down. Aborting the signal interrupts in-flight requests.
 */
export function runMobileBackgroundSync(
  options: HeadlessSync.HeadlessSyncOptions,
  signal?: AbortSignal,
): Promise<HeadlessSync.HeadlessSyncResult> {
  const runtime = ManagedRuntime.make(layerBackgroundSync);
  return runtime
    .runPromise(
      Effect.flatMap(HeadlessSync.HeadlessSync, (sync) => sync.run(options)),
      { signal },
    )
    .finally(() => runtime.dispose());
}
