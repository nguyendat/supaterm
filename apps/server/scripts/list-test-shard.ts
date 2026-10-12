// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import { createVitest } from "vite-plus/test/node";

const shard = process.argv[2];
if (!shard) throw new Error("Usage: node scripts/list-test-shard.ts <index>/<count>");

const vitest = await createVitest("test", {
  root: NodeURL.fileURLToPath(new URL("..", import.meta.url)),
  shard,
  watch: false,
});

try {
  const files = await vitest.globTestSpecifications();
  const sequencer = new vitest.config.sequence.sequencer(vitest);
  const selected = await sequencer.shard(files);
  process.stdout.write(`${selected.map((file) => file.moduleId).join("\n")}\n`);
} finally {
  await vitest.close();
}
