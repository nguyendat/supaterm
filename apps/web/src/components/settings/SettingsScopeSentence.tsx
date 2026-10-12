import { useLocation } from "@tanstack/react-router";

import { useEnvironments } from "../../state/environments";
import { ScopeSentence } from "./ScopeSentence";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

/** Pages whose every row is saved on this client; they have no scope to pick. */
export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/appearance",
  "/settings/snap-shot",
  "/settings/micro",
  "/settings/connections",
]);

/**
 * "Applying settings for <project> across <environment>" at the top of a settings
 * page. The two pickers are the targets a change is written to. A project is
 * the same project on every environment, so the environment alone decides
 * where a project override is written.
 */
export function SettingsScopeSentence() {
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  return (
    <ScopeSentence
      lead="Applying settings for"
      value={scope.search}
      scope={scope.scope}
      singleEnvironment={scope.singleEnvironment}
      groups={scope.groups}
      environments={environments}
      onChange={scope.selectScope}
    />
  );
}
