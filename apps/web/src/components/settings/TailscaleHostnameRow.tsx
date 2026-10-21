import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { tailnetConfirmationMessage, tailnetHostnameError } from "./TailscaleSettings.logic";

export function TailscaleHostnameRow({
  hostname,
  dnsName,
  lockoutWarning,
  disabled,
  renaming,
  onRename,
}: {
  readonly hostname: string;
  readonly dnsName: string | undefined;
  readonly lockoutWarning: string | null;
  readonly disabled: boolean;
  readonly renaming: boolean;
  readonly onRename: (hostname: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const error = draft === null ? null : tailnetHostnameError(draft.trim());

  const commit = async () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next === hostname) {
      setDraft(null);
      return;
    }
    if (tailnetHostnameError(next) !== null) return;
    const confirmed = await requestConfirmDialog(
      tailnetConfirmationMessage(
        `Rename this device to ${next}?`,
        "Its Tailscale address may change, and devices paired only by name may need to pair again. The new name is published in public certificate logs.",
        lockoutWarning,
      ),
    );
    if (confirmed !== true) {
      setDraft(null);
      return;
    }
    if (await onRename(next)) setDraft(null);
  };

  return (
    <SettingsRow
      title="Preferred Hostname"
      description={
        dnsName
          ? `Used to generate the Tailscale address, now ${dnsName}.`
          : "Used to generate the Tailscale address."
      }
      status={
        error !== null ? (
          <span className="block text-destructive">{error}</span>
        ) : renaming ? (
          "Renaming…"
        ) : null
      }
      control={
        <div className="w-full @min-[32rem]/settings-row:w-64">
          <Input
            size="sm"
            aria-label="Preferred Hostname"
            value={draft ?? hostname}
            disabled={disabled}
            aria-invalid={error !== null}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape" && draft !== null) {
                event.preventDefault();
                event.stopPropagation();
                setDraft(null);
              }
            }}
          />
        </div>
      }
    />
  );
}
