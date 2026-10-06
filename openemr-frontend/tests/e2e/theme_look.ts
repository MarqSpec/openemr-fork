import {expect, type Page} from '@playwright/test';

import {DARK_TOKENS, LIGHT_TOKENS} from '../../src/theme/tokens';

// reference: REQUIREMENTS.md FR-UI-2, a separate change — a theme is checked by what the user sees, not by the root's
// data-theme attribute (CONVENTIONS.md: roles and accessible names only, no DOM structure).

/** `#rrggbb` → the `rgb(r, g, b)` form `getComputedStyle` reports. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return `rgb(${channels.join(', ')})`;
}

/** Asserts the app is drawn in `mode`: the app bar (the page's banner) has that theme's surface colour. */
export async function expectDrawnIn(
  page: Page,
  mode: 'light' | 'dark',
): Promise<void> {
  const tokens = mode === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
  await expect(page.getByRole('banner')).toHaveCSS(
    'background-color',
    rgb(tokens.surface),
  );
}
