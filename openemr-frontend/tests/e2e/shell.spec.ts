import {expect, test} from '@playwright/test';

import {stubSignedOut} from './bff_stubs';

// reference: REQUIREMENTS.md FR-UI-2, a separate change — selectors are roles and accessible names only

test.describe('given the app shell', () => {
  test('when it loads, then the app bar shows the OpenEMR logo and name (guards a blank or unbranded shell)', async ({
    page,
  }) => {
    await stubSignedOut(page);
    await page.goto('/');

    const banner = page.getByRole('banner');
    await expect(banner.getByRole('img', {name: 'OpenEMR'})).toBeVisible();
    await expect(banner.getByText('OpenEMR', {exact: true})).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
  });
});
