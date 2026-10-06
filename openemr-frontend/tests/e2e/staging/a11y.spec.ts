import {expect, test, type Page} from '@playwright/test';

import {blockingViolations} from '../axe';
import {expectDrawnIn} from '../theme_look';
import {
  STAGING_BASE_URL,
  STAGING_SKIP_REASON,
  signInThroughBff,
  signOutThroughBff,
  stagingConfigured,
} from './helpers';

// Staging axe scans (NFR-A11Y-1, NFR-COMPAT-1): WCAG 2.x A/AA in both themes at both tablet viewports
// against the deployed SPA. Skipped unless STAGING_BASE_URL and credentials are set.
// Every scan goes through ../axe.ts, which waits for the theme menu to leave the page first.
// A theme is checked by what the user sees (../theme_look.ts expectDrawnIn), never by data-theme.
// reference: REQUIREMENTS.md NFR-A11Y-1, CONVENTIONS.md

const themeButton = (page: Page) =>
  page.getByRole('banner').getByRole('button', {name: 'Theme'});

async function chooseTheme(page: Page, theme: 'Light' | 'Dark') {
  await themeButton(page).click();
  await page.getByRole('menuitemradio', {name: theme}).click();
  await expect(page.getByRole('menu')).toBeHidden();
  await expectDrawnIn(page, theme === 'Dark' ? 'dark' : 'light');
}

test.describe('axe accessibility on staging (NFR-A11Y-1)', () => {
  test.skip(!stagingConfigured, STAGING_SKIP_REASON);
  test.setTimeout(180_000);

  for (const theme of ['Light', 'Dark'] as const) {
    test(`when axe scans the sign-in screen in ${theme} theme on staging, then it finds no serious or critical WCAG violations (guards contrast and naming regressions on the deployed SPA)`, async ({
      page,
    }) => {
      const base = String(STAGING_BASE_URL);
      await page.goto(`${base}/`);
      await chooseTheme(page, theme);

      await expect(
        page.getByRole('button', {name: 'Sign in with OpenEMR'}),
      ).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
    });

    test(`when axe scans the signed-in dashboard in ${theme} theme on staging, then it finds no serious or critical WCAG violations (guards the authenticated UI)`, async ({
      page,
    }) => {
      const base = String(STAGING_BASE_URL);
      await signInThroughBff(page, base);

      await chooseTheme(page, theme);
      await expect(
        page.getByRole('heading', {name: 'Patient search'}),
      ).toBeVisible();

      expect(await blockingViolations(page)).toEqual([]);

      await signOutThroughBff(page);
    });

    test(`when axe scans the signed-out page in ${theme} theme on staging, then it finds no serious or critical WCAG violations`, async ({
      page,
    }) => {
      const base = String(STAGING_BASE_URL);
      await page.goto(`${base}/signed-out?reason=signout_complete`);
      await chooseTheme(page, theme);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }
});
