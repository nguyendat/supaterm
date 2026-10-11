const STORAGE_KEY = "supacode:pairing-setup-resume:v1";
const RESUME_WINDOW_MS = 5 * 60 * 1000;
let startupChecked = false;

export function readPairingSetupResume(): string | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (
      value !== null &&
      typeof value === "object" &&
      "environmentId" in value &&
      "expiresAt" in value &&
      typeof value.environmentId === "string" &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > Date.now()
    )
      return value.environmentId;
  } catch {}
  return null;
}

export function savePairingSetupResume(environmentId: string): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ environmentId, expiresAt: Date.now() + RESUME_WINDOW_MS }),
    );
  } catch {
    throw new Error(
      "Supacode could not save the setup for restart. Enable Public relay to continue without restarting.",
    );
  }
}

export function clearPairingSetupResume(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function shouldResumePairingSetupOnStartup(): boolean {
  if (startupChecked) return false;
  startupChecked = true;
  return readPairingSetupResume() !== null;
}
