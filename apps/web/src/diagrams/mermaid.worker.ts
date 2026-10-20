import { create } from "ondine/compiler/wasm";
import allWasmUrl from "ondine/compiler/wasm/all.wasm?url";
import { MERMAID_ASCII_LIMITS } from "@supaterm/mermaid-ascii/limits";

const renderer = WebAssembly.compileStreaming(fetch(allWasmUrl)).then((all) =>
  create({ modules: { all } }),
);
let nextId = 0;

self.addEventListener("message", async (event: MessageEvent<{ source: string }>) => {
  try {
    const { svg } = (await renderer).render(event.data.source, {
      idPrefix: `mermaid-${nextId++}-`,
      limit: MERMAID_ASCII_LIMITS.sourceChars,
      outputLimit: MERMAID_ASCII_LIMITS.canvasCells * 2,
      maxWidth: 720,
    });
    self.postMessage({ output: svg }, { transfer: [] });
  } catch {
    self.postMessage({ error: true }, { transfer: [] });
  }
});

void renderer.then(
  () => self.postMessage({ ready: true }, { transfer: [] }),
  () => self.postMessage({ ready: false }, { transfer: [] }),
);
