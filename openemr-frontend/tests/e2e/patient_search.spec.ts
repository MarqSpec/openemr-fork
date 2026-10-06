import {expect, test, type Locator, type Page} from '@playwright/test';

import {blockingViolations} from './axe';
import {stubPatientSearch, stubSignedIn} from './bff_stubs';

// Patient search (W-2) and the switch-patient confirmation (W-12c), local tier. /bff/session and API-11 are
// stubbed for layout only (bff_stubs.ts). reference: REQUIREMENTS.md FR-PAT-1, FR-PAT-2, FR-UI-7, NFR-A11Y-1,
// NFR-A11Y-2, NFR-SEC-6 · INTERFACES.md API-11 · REQUIREMENTS.md W-2, W-12c

const TERM = 'Testperson';

async function search(page: Page): Promise<Locator> {
  await page.getByRole('textbox', {name: 'Name'}).fill(TERM);
  await page.getByRole('button', {name: 'Search'}).click();
  const list = page.getByRole('list', {name: 'Search results'});
  await expect(list).toBeVisible();
  return list;
}

const row = (list: Locator, given: string) =>
  list.getByRole('button', {name: new RegExp(`^${given} Testperson `)});

async function chooseTheme(page: Page, theme: 'Light' | 'Dark') {
  await page.getByRole('banner').getByRole('button', {name: 'Theme'}).click();
  await page.getByRole('menuitemradio', {name: theme}).click();
  await expect(page.getByRole('menu')).toBeHidden();
}

test.describe('given a signed-in clinician on patient search', () => {
  test.beforeEach(async ({page}) => {
    await stubSignedIn(page);
    await stubPatientSearch(page, 25);
    await page.goto('/');
    await expect(
      page.getByRole('heading', {level: 1, name: 'Patient search'}),
    ).toBeVisible();
  });

  test('when results show, then every row is at least 52 dp tall and the paging controls at least 48 dp (guards undersized targets, NFR-A11Y-2)', async ({
    page,
  }) => {
    const list = await search(page);
    for (const button of await list.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(52);
    }
    for (const name of ['Previous page', 'Next page', 'Search']) {
      const box = await page.getByRole('button', {name}).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
    }
  });

  test('when a search runs, pages and opens a chart, then the address never holds the search term, and Back returns to the results (guards PHI in the URL, FR-PAT-2)', async ({
    page,
  }) => {
    const list = await search(page);
    expect(page.url()).not.toContain(TERM);
    await page.getByRole('button', {name: 'Next page'}).click();
    await expect(page.getByText('Page 2 · 5 patients')).toBeVisible();
    expect(page.url()).not.toContain(TERM);

    await row(list, 'Fakey21').click();
    await expect(page).toHaveURL(/\/patient\/test-patient-0021$/);
    expect(page.url()).not.toMatch(/Testperson|Fakey|1970|TEST-MRN/);
    const header = page.getByRole('region', {name: 'Patient'});
    await expect(
      header.getByRole('heading', {level: 1, name: 'Fakey21 Testperson'}),
    ).toBeFocused();
    await expect(page.getByRole('region', {name: 'Dashboard'})).toBeVisible();

    await page.goBack();
    await expect(row(list, 'Fakey22')).toBeVisible();
    await expect(page.getByText('Page 2 · 5 patients')).toBeVisible();
    await expect(page.getByRole('textbox', {name: 'Name'})).toHaveValue(TERM);
    await expect(
      page.getByRole('region', {name: 'Patient', exact: true}),
    ).toHaveCount(0);
  });

  test('when "Open another chart?" is confirmed, then the new chart opens with focus on the name in its header (W-12c)', async ({
    page,
  }) => {
    const list = await search(page);
    await row(list, 'Fakey1').click();
    await expect(
      page.getByRole('heading', {level: 1, name: 'Fakey1 Testperson'}),
    ).toBeFocused();
    await page.goBack();
    await row(list, 'Fakey2').click();
    await page
      .getByRole('alertdialog', {name: 'Open another chart?'})
      .getByRole('button', {name: 'Open chart'})
      .click();

    await expect(page).toHaveURL(/\/patient\/test-patient-0002$/);
    await expect(
      page
        .getByRole('region', {name: 'Patient'})
        .getByRole('heading', {level: 1, name: 'Fakey2 Testperson'}),
    ).toBeFocused();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });
});

for (const theme of ['Light', 'Dark'] as const) {
  test.describe(`given the ${theme} theme`, () => {
    test.beforeEach(async ({page}) => {
      await stubSignedIn(page);
      await stubPatientSearch(page, 25);
      await page.goto('/');
      await chooseTheme(page, theme);
    });

    test('when axe scans the search form with a field error, then it finds no serious or critical WCAG violations (W-2)', async ({
      page,
    }) => {
      await page.getByRole('textbox', {name: 'Name'}).fill('F');
      await page.getByRole('button', {name: 'Search'}).click();
      await expect(page.getByText('Enter at least 2 letters.')).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
    });

    test('when axe scans a page of results, then it finds no serious or critical WCAG violations (W-2)', async ({
      page,
    }) => {
      await search(page);
      expect(await blockingViolations(page)).toEqual([]);
    });

    test('when axe scans "Open another chart?", then it finds no serious or critical WCAG violations, and Cancel has focus (W-12c)', async ({
      page,
    }) => {
      const list = await search(page);
      await row(list, 'Fakey1').click();
      await page
        .getByRole('banner')
        .getByRole('button', {name: 'Patients'})
        .click();
      await row(
        page.getByRole('list', {name: 'Search results'}),
        'Fakey2',
      ).click();

      const dialog = page.getByRole('alertdialog', {
        name: 'Open another chart?',
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', {name: 'Cancel'})).toBeFocused();
      expect(await blockingViolations(page)).toEqual([]);
    });
  });
}
