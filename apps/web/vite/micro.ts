import type { Plugin } from "vite-plus";

export function excludeMicroFromWeb(): Plugin {
  return {
    name: "supacode:exclude-desktop-micro",
    enforce: "pre",
    resolveId(source) {
      if (source.startsWith("@supacode/micro/"))
        this.error("Micro device support must be imported through the desktop integration.");
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) {
          if (id.replaceAll("\\", "/").includes("/packages/micro/"))
            this.error("Micro device support cannot be included in a web bundle.");
        }
      }
    },
  };
}
