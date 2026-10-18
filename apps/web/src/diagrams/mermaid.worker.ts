import { renderMermaidSvg, type SvgRenderOptions } from "@supaterm/mermaid/svg";

const options: SvgRenderOptions = {
  colors: {
    bg: "var(--code-background, var(--background))",
    fg: "var(--code-foreground, var(--foreground))",
    muted: "var(--muted-foreground)",
  },
  font: "var(--font-sans, system-ui, sans-serif)",
};

self.addEventListener("message", (event: MessageEvent<{ source: string }>) => {
  try {
    self.postMessage({ output: renderMermaidSvg(event.data.source, options) }, { transfer: [] });
  } catch {
    self.postMessage({ error: true }, { transfer: [] });
  }
});

self.postMessage({ ready: true }, { transfer: [] });
