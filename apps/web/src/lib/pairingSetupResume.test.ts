import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("redirects once after restart and retains the environment until the dialog resumes", async () => {
  const before = await import("./pairingSetupResume");
  expect(before.shouldResumePairingSetupOnStartup()).toBe(false);
  before.savePairingSetupResume("host-environment");
  expect(before.shouldResumePairingSetupOnStartup()).toBe(false);

  vi.resetModules();
  const after = await import("./pairingSetupResume");
  expect(after.shouldResumePairingSetupOnStartup()).toBe(true);
  expect(after.shouldResumePairingSetupOnStartup()).toBe(false);
  expect(after.readPairingSetupResume()).toBe("host-environment");
  after.clearPairingSetupResume();

  vi.resetModules();
  const closed = await import("./pairingSetupResume");
  expect(closed.shouldResumePairingSetupOnStartup()).toBe(false);
});

it("does not resume an old request on a later startup", async () => {
  const resume = await import("./pairingSetupResume");
  vi.spyOn(Date, "now").mockReturnValue(1000);
  resume.savePairingSetupResume("host-environment");
  vi.spyOn(Date, "now").mockReturnValue(1000 + 5 * 60 * 1000);
  expect(resume.readPairingSetupResume()).toBeNull();
  expect(resume.shouldResumePairingSetupOnStartup()).toBe(false);
});

it("does not redirect when storage is unavailable", async () => {
  vi.stubGlobal("window", {});
  const resume = await import("./pairingSetupResume");
  expect(resume.shouldResumePairingSetupOnStartup()).toBe(false);
  expect(() => resume.clearPairingSetupResume()).not.toThrow();
  expect(() => resume.savePairingSetupResume("host-environment")).toThrow();
});
