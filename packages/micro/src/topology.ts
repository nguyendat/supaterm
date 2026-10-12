import * as NodeModule from "node:module";
import * as Schema from "effect/Schema";
import type { NativeHid } from "./native.ts";

const MicroInterface = Schema.Struct({
  path: Schema.String,
  vendorId: Schema.Int,
  productId: Schema.Int,
  usagePage: Schema.Int,
  release: Schema.Int,
  product: Schema.String,
  transport: Schema.Literals(["USB", "Bluetooth"]),
});
export type MicroInterface = typeof MicroInterface.Type;
export interface MicroTopology {
  find(): Promise<readonly MicroInterface[]>;
  watch(listener: () => void): () => void;
}
const decodeInterfaces = Schema.decodeUnknownSync(Schema.Array(MicroInterface));
type NativeTopology = {
  find(): Promise<unknown>;
  watch(listener: () => void): { close(): void };
};

export function macMicroTopology(path: string): MicroTopology {
  let native: NativeTopology | undefined;
  const addon = () => (native ??= NodeModule.createRequire(path)(path) as NativeTopology);
  return {
    find: async () => decodeInterfaces(await addon().find()),
    watch: (listener) => {
      const watcher = addon().watch(listener);
      return () => watcher.close();
    },
  };
}

export const macMicroHid = (directory: string): NativeHid =>
  NodeModule.createRequire(`${directory}/driver.cjs`)(`${directory}/driver.cjs`) as NativeHid;
