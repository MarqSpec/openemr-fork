import {expect, type Page} from '@playwright/test';

// Shared staging-tier helpers. Real OpenEMR login — no stubs.
// reference: CONVENTIONS.md, a separate change

export const STAGING_BASE_URL = process.env.STAGING_BASE_URL;
export const STAGING_USER = process.env.STAGING_OPENEMR_USER;
export const STAGING_PASSWORD = process.env.STAGING_OPENEMR_PASSWORD;

/** Demo patient search term — synthetic data only (a demo patient on staging). */
export const STAGING_PATIENT_SEARCH =
  process.env.STAGING_PATIENT_SEARCH ?? 'Phil';

export const stagingConfigured =
  STAGING_BASE_URL !== undefined &&
  STAGING_USER !== undefined &&
  STAGING_PASSWORD !== undefined;

export const STAGING_SKIP_REASON =
  'staging tier: set STAGING_BASE_URL, STAGING_OPENEMR_USER and STAGING_OPENEMR_PASSWORD';

/** A form post from the page's own document — what the SPA's sign-in and sign-out controls send. */
export async function postForm(page: Page, action: string): Promise<void> {
  await page.evaluate(target => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = target;
    document.body.append(form);
    form.submit();
  }, action);
}

/** OpenEMR's own login and consent pages (fields are found by their visible labels). */
export async function signInAtOpenemr(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.getByRole('textbox', {name: 'Registered username'}).fill(username);
  await page.getByLabel('Password', {exact: true}).fill(password);
  await page.getByRole('button', {name: 'OpenEMR Login'}).click();
  await page.getByRole('button', {name: 'Authorize'}).click();
}

/** Sign in through the token handler and land back on the SPA. */
export async function signInThroughBff(
  page: Page,
  base: string,
): Promise<void> {
  await page.goto(`${base}/`);
  await postForm(page, '/bff/login');
  await page.waitForURL(url => url.origin !== new URL(base).origin);
  await signInAtOpenemr(page, String(STAGING_USER), String(STAGING_PASSWORD));
  await page.waitForURL(`${base}/`);
}

/** Sign out through the token handler and land on the signed-out screen. */
export async function signOutThroughBff(page: Page): Promise<void> {
  await postForm(page, '/bff/logout');
  await page.waitForURL('**/signed-out**');
}

/**
 * Search for a demo patient and open the first result when one exists. Returns visible clinical
 * text samples from the chart header for the storage audit to reject in every store.
 */
export async function usePatientSearch(page: Page): Promise<string[]> {
  await expect(
    page.getByRole('heading', {level: 1, name: 'Patient search'}),
  ).toBeVisible();

  await page.getByRole('textbox', {name: 'Name'}).fill(STAGING_PATIENT_SEARCH);
  await page.getByRole('button', {name: 'Search'}).click();

  const list = page.getByRole('list', {name: 'Search results'});
  const hasResults = await list
    .getByRole('button')
    .first()
    .isVisible()
    .catch(() => false);

  if (!hasResults) {
    return [];
  }

  await list.getByRole('button').first().click();
  await expect(page).toHaveURL(/\/patient\//);

  const samples: string[] = [];
  const name = await page.getByRole('heading', {level: 1}).textContent();
  if (name?.trim()) samples.push(name.trim());
  for (const fact of await page.locator('dd').allTextContents()) {
    const trimmed = fact.trim();
    if (trimmed && trimmed !== '—') samples.push(trimmed);
  }
  return samples;
}
