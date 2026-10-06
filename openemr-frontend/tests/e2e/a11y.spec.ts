import {expect, test, type Page} from '@playwright/test';

import {blockingViolations} from './axe';
import {CLINICIAN, stubSignedIn, stubSignedOut} from './bff_stubs';
import {expectDrawnIn} from './theme_look';

// reference: REQUIREMENTS.md NFR-A11Y-1, a separate change — WCAG 2.x A/AA, no serious or critical findings.
// Touch-target size is not axe's to prove: its target-size rule checks 24 px, not 48 dp. The 48 dp targets are
// measured in the theme, account_menu, auto_logoff, patient_search and dashboard specs.
// /bff/session is stubbed for layout only (bff_stubs.ts): it picks the screen, it is not under test.

const themeButton = (page: Page) =>
  page.getByRole('banner').getByRole('button', {name: 'Theme'});

async function chooseTheme(page: Page, theme: 'Light' | 'Dark') {
  await themeButton(page).click();
  await page.getByRole('menuitemradio', {name: theme}).click();
  await expect(page.getByRole('menu')).toBeHidden();
  await expectDrawnIn(page, theme === 'Dark' ? 'dark' : 'light');
}

for (const theme of ['Light', 'Dark'] as const) {
  test.describe(`given the ${theme} theme`, () => {
    test.beforeEach(async ({page}) => {
      await stubSignedOut(page);
      await page.goto('/');
      await chooseTheme(page, theme);
    });

    test('when axe scans the shell on the sign-in screen (W-1), then it finds no serious or critical WCAG violations (guards contrast, naming and landmark regressions)', async ({
      page,
    }) => {
      await expect(
        page.getByRole('button', {name: 'Sign in with OpenEMR'}),
      ).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
    });

    test('when axe scans the signed-out page with a warning notice, then it finds no serious or critical WCAG violations (guards an illegible notice)', async ({
      page,
    }) => {
      await page.goto('/signed-out?reason=signout_partial');
      await expect(page.getByRole('alert')).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
    });

    test('when axe scans the signed-out page with an error notice, then it finds no serious or critical WCAG violations (guards an illegible notice)', async ({
      page,
    }) => {
      await page.goto('/signed-out?reason=signin_failed');
      await expect(page.getByRole('alert')).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
    });

    test('when axe scans the open theme menu, then it finds no serious or critical WCAG violations (guards an inaccessible selector)', async ({
      page,
    }) => {
      await themeButton(page).click();
      await expect(page.getByRole('menu')).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
    });
  });
}

for (const theme of ['Light', 'Dark'] as const) {
  test.describe(`given a signed-in clinician in the ${theme} theme`, () => {
    const accountButton = (page: Page) =>
      page
        .getByRole('banner')
        .getByRole('button', {name: `Signed in as ${CLINICIAN}`});

    test.beforeEach(async ({page}) => {
      await stubSignedIn(page);
      await page.goto('/');
      await expect(accountButton(page)).toBeVisible();
      await chooseTheme(page, theme);
    });

    test('when axe scans the open account menu, then it finds no serious or critical WCAG violations (guards an inaccessible account menu)', async ({
      page,
    }) => {
      await accountButton(page).click();
      await expect(page.getByRole('menu', {name: 'Account'})).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
    });

    test('when axe scans the sign-out confirmation, then it finds no serious or critical WCAG violations (guards an inaccessible dialog)', async ({
      page,
    }) => {
      await accountButton(page).click();
      await page.getByRole('menuitem', {name: 'Sign out'}).click();
      await expect(
        page.getByRole('alertdialog', {name: 'Sign out?'}),
      ).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
    });
  });
}
