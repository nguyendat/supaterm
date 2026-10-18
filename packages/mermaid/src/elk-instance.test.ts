import { expect, it } from "vite-plus/test";

it("lays out inside a dedicated worker scope without claiming its message handler", async () => {
  const scope = globalThis as { self?: unknown; onmessage?: unknown };
  const hadSelf = "self" in scope;
  if (!hadSelf) scope.self = globalThis;
  try {
    const { elkLayoutSync } = await import("./elk-instance.ts");
    const result = elkLayoutSync({
      id: "root",
      children: [
        { id: "a", width: 10, height: 10 },
        { id: "b", width: 10, height: 10 },
      ],
      edges: [{ id: "e", sources: ["a"], targets: ["b"] }],
    });
    expect(result.children?.every((child) => Number.isFinite(child.x))).toBe(true);
    expect(scope.onmessage).toBeUndefined();
  } finally {
    if (!hadSelf) delete scope.self;
  }
});
