// The build's own version (FR-UI-3). vite.config.ts injects both constants at build time: the version from
// package.json, the commit from the build environment when it has one. A separate change (note 87776)

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

/** "v0.1.0", or "v0.1.0 · 04a9991" when the commit is known. */
export function formatAppVersion(version: string, commit: string): string {
  const short = commit.trim().slice(0, 7);
  return short === '' ? `v${version}` : `v${version} · ${short}`;
}

export const APP_VERSION = formatAppVersion(__APP_VERSION__, __APP_COMMIT__);
