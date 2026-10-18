import { createDiagramRenderer } from "@supaterm/client-runtime/diagram-rendering";
import { MERMAID_LIMITS, MERMAID_OUTPUT_CHARS } from "@supaterm/mermaid/limits";

export function createBrowserDiagramRenderer() {
  let worker: Worker | undefined;
  let ready = false;

  return createDiagramRenderer(
    (source) =>
      new Promise<string | null>((resolve, reject) => {
        const activeWorker = (worker ??= new Worker(
          new URL("./mermaid.worker.ts", import.meta.url),
          {
            type: "module",
          },
        ));
        let settled = false;
        let sent = false;
        const finish = (output: string | null, outcome: "done" | "retry" | "abandon" = "done") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          activeWorker.removeEventListener("message", handleMessage);
          activeWorker.removeEventListener("error", handleError);
          activeWorker.removeEventListener("messageerror", handleMessageError);
          if (outcome !== "done") {
            activeWorker.terminate();
            worker = undefined;
            ready = false;
          }
          if (outcome === "retry") reject(new Error("Diagram preview unavailable"));
          else resolve(output);
        };
        let timer = setTimeout(() => finish(null, "retry"), 15_000);
        const send = () => {
          if (sent) return;
          sent = true;
          clearTimeout(timer);
          // Layout cannot be interrupted, and a source that outlives the deadline would
          // outlive it again, so it resolves as unrenderable and is remembered.
          timer = setTimeout(() => finish(null, "abandon"), MERMAID_LIMITS.durationMs * 2);
          try {
            activeWorker.postMessage({ source }, []);
          } catch {
            finish(null, "retry");
          }
        };
        const handleMessage = (event: MessageEvent<unknown>) => {
          const data = event.data;
          if (typeof data !== "object" || data === null) {
            finish(null, "retry");
            return;
          }
          if (!sent) {
            if (!("ready" in data) || data.ready !== true) {
              finish(null, "retry");
              return;
            }
            ready = true;
            send();
          } else if ("output" in data && typeof data.output === "string") {
            finish(data.output);
          } else if ("error" in data && data.error === true) {
            finish(null);
          } else {
            finish(null, "retry");
          }
        };
        const handleError = (event: ErrorEvent) => {
          event.preventDefault();
          finish(null, "retry");
        };
        const handleMessageError = () => finish(null, "retry");
        activeWorker.addEventListener("message", handleMessage);
        activeWorker.addEventListener("error", handleError);
        activeWorker.addEventListener("messageerror", handleMessageError);
        if (ready) send();
      }),
    { maxOutputChars: MERMAID_OUTPUT_CHARS.svg, maxCacheBytes: 8 * 1024 * 1024 },
  );
}

const renderer = createBrowserDiagramRenderer();

export function renderMermaidDiagram(source: string) {
  return renderer.render(source);
}
