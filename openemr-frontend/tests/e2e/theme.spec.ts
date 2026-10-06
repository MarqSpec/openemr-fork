import {expect, test, type Page} from '@playwright/test';

import {stubSignedOut} from './bff_stubs';
import {expectDrawnIn} from './theme_look';

// reference: REQUIREMENTS.md FR-UI-2 (Light · Dark · Match device, remembered on this device), NFR-A11Y-2, a separate change

async function chooseTheme(page: Page, label: string): Promise<void> {
  await page.getByRole('banner').getByRole('button', {name: 'Theme'}).click();
  await page.getByRole('menuitemradio', {name: label}).click();
  await expect(page.getByRole('menu')).toBeHidden();
}

async function expectChecked(page: Page, label: string): Promise<void> {
  await page.getByRole('banner').getByRole('button', {name: 'Theme'}).click();
  await expect(page.getByRole('menuitemradio', {name: label})).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
}

test.describe('given the theme menu', () => {
  test.beforeEach(async ({page}) => {
    await stubSignedOut(page);
    await page.emulateMedia({colorScheme: 'light'});
    await page.goto('/');
  });

  test('when Dark is chosen, then the page turns dark and stays dark after a reload (guards a choice that is not persisted)', async ({
    page,
  }) => {
    await chooseTheme(page, 'Dark');
    await expectDrawnIn(page, 'dark');

    await page.reload();
    await expectDrawnIn(page, 'dark');
    await expectChecked(page, 'Dark');
  });

  test('when Light is chosen on a dark device, then the page stays light after a reload (guards the device overriding an explicit choice)', async ({
    page,
  }) => {
    await page.emulateMedia({colorScheme: 'dark'});
    await chooseTheme(page, 'Light');
    await expectDrawnIn(page, 'light');

    await page.reload();
    await expectDrawnIn(page, 'light');
    await expectChecked(page, 'Light');
  });

  test('when Match device is chosen, then the page follows the device scheme, also after a reload (guards a stale or ignored device preference)', async ({
    page,
  }) => {
    await chooseTheme(page, 'Dark');
    await chooseTheme(page, 'Match device');
    await expectDrawnIn(page, 'light');

    await page.emulateMedia({colorScheme: 'dark'});
    await expectDrawnIn(page, 'dark');

    await page.reload();
    await expectDrawnIn(page, 'dark');
    await expectChecked(page, 'Match device');
  });

  test('when the menu is open, then every option is at least 48 × 48 dp (guards MenuItem dropping to 36 dp from the sm breakpoint up, NFR-A11Y-2)', async ({
    page,
  }) => {
    await page.getByRole('banner').getByRole('button', {name: 'Theme'}).click();
    // The menu grows in from a scale; measure once the transition is over.
    await page.waitForFunction(() => document.getAnimations().length === 0);
    for (const label of ['Light', 'Dark', 'Match device']) {
      const box = await page
        .getByRole('menuitemradio', {name: label})
        .boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
    }
  });
});
