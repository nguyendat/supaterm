/**
 * Packages the desktop main-process bundle must NOT inline.
 *
 * The desktop bundle follows the same policy as the server CLI bundle (see
 * cli-external-packages.ts): everything is inlined except what Node has to
 * load from the real filesystem. Both `apps/desktop/vite.config.ts` and the
 * artifact stage in scripts/build-desktop-artifact.ts derive from this list,
 * so a package that is external is also the only kind of package the staged
 * production install carries. Anything not listed here ships inside
 * `dist-electron/*.cjs` and has no `node_modules` presence at all.
 *
 * Entries are matched as prefixes so platform-specific siblings are covered.
 */
export const DESKTOP_RUNTIME_EXTERNAL_PREFIXES = [
  // Native addons and the wrappers that dlopen them by real path.
  "@napi-rs/keyring",
  "@crowecawcaw/xa11y",
  "electron-webauthn",
  "ffi-rs",
  "@yuuang/",
  // Desktop injection reads coreBundle.js; the server browser loads the full runtime.
  "playwright-core",
] as const;

export const DESKTOP_RUNTIME_FILE_EXCLUSIONS = [
  // Cursor's createRequire entry uses only CommonJS and its computed chunks.
  "!**/node_modules/@cursor/sdk/dist/{esm,bundled}/**/*",
] as const;

export function isDesktopRuntimeExternalDependency(id: string): boolean {
  return DESKTOP_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Select the desktop dependency roots whose runtime closure the stage must install. */
export function selectDesktopRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isDesktopRuntimeExternalDependency(name)),
  );
}
