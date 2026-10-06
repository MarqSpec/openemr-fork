import {expect, test, type Page} from '@playwright/test';

import {blockingViolations} from './axe';
import {capturePost, CLINICIAN, stubPatientSearch} from './bff_stubs';

// Automatic logoff (W-6) and the privacy screen (W-7), local tier, on Playwright's fake clock. /bff/session is
// stubbed for layout only, with a far expiry so the client idle clock (idleTimeoutSeconds) is what fires; the
// server-clock cases are the unit tests' (src/auth/auto_logoff.test.tsx).
// reference: REQUIREMENTS.md FR-AUTH-4, FR-UI-4, NFR-A11Y-1 · INTERFACES.md API-42, API-43, API-46 ·
// REQUIREMENTS.md W-6, W-7

async function stubSession(page: Page): Promise<void> {
  await page.route('**/bff/session', route =>
    route.fulfill({
      status: 200,
      json: {
        authenticated: true,
        user: {displayName: CLINICIAN},
        expiresAt: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
        idleTimeoutSeconds: 900,
        grantedScopes: ['openid', 'fhirUser'],
      },
    }),
  );
}

const accountButton = (page: Page) =>
  page
    .getByRole('banner')
    .getByRole('button', {name: `Signed in as ${CLINICIAN}`});

const warning = (page: Page) =>
  page.getByRole('alertdialog', {name: 'Still there?'});

async function signedIn(page: Page): Promise<void> {
  await page.clock.install();
  await stubSession(page);
  await page.goto('/');
  await expect(accountButton(page)).toBeVisible();
}

async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate(next => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => next,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test.describe('given a signed-in clinician who leaves the tablet idle', () => {
  test.beforeEach(async ({page}) => {
    await signedIn(page);
  });

  test('when 14 minutes pass, then the "Still there?" alertdialog opens with "Stay signed in" focused and 48 dp actions (guards a silent logoff, W-6)', async ({
    page,
  }) => {
    await page.clock.runFor('13:30');
    await expect(warning(page)).toBeHidden();

    await page.clock.runFor('00:35');
    await expect(warning(page)).toBeVisible();
    await expect(warning(page)).toHaveAttribute('aria-modal', 'true');
    const stay = warning(page).getByRole('button', {name: 'Stay signed in'});
    await expect(stay).toBeFocused();
    for (const name of ['Stay signed in', 'Sign out now']) {
      const box = await warning(page).getByRole('button', {name}).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
    }
  });

  test('when the warning runs out, then the browser signs out with the same-origin form POST to /bff/logout (guards a timeout that leaves the session open)', async ({
    page,
  }) => {
    const sent = await capturePost(page, '/bff/logout');
    await page.clock.runFor('14:05');
    await expect(warning(page)).toBeVisible();

    await page.clock.runFor('01:00');
    await page.waitForURL('**/bff/logout');

    expect(sent()).toMatchObject({
      method: 'POST',
      isNavigation: true,
      body: 'reason=idle',
      authorization: undefined,
    });
  });

  test('when "Stay signed in" is chosen, then one POST goes to /bff/session/activity, nothing to the FHIR proxy, and the warning closes (guards an extend that never reaches the server)', async ({
    page,
  }) => {
    let keepAlives = 0;
    let fhirReads = 0;
    await page.route('**/bff/session/activity', route => {
      if (route.request().method() === 'POST') keepAlives += 1;
      return route.fulfill({
        status: 200,
        json: {
          expiresAt: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
        },
      });
    });
    await page.route('**/bff/fhir/**', route => {
      fhirReads += 1;
      return route.fallback();
    });
    await page.clock.runFor('14:05');
    fhirReads = 0;
    await warning(page).getByRole('button', {name: 'Stay signed in'}).click();

    await expect(warning(page)).toBeHidden();
    expect(keepAlives).toBe(1);
    expect(fhirReads).toBe(0);
  });
});

test('given a signed-in clinician reading a chart that makes no server request, when they scroll and tap within the idle period, then at 14 minutes one keep-alive goes out instead of the warning (guards input not counting as activity, FR-AUTH-4)', async ({
  page,
}) => {
  // A server whose idle clock only a keep-alive restarts, on a timeline this spec moves with the page clock.
  const base = Date.now();
  let elapsed = 0;
  let serverEnds = 15 * 60 * 1000;
  let keepAlives = 0;
  await page.route('**/bff/session', route =>
    route.fulfill({
      status: 200,
      headers: {Date: new Date(base + elapsed).toUTCString()},
      json: {
        authenticated: true,
        user: {displayName: CLINICIAN},
        expiresAt: new Date(base + serverEnds).toISOString(),
        idleTimeoutSeconds: 900,
        grantedScopes: ['openid', 'fhirUser'],
      },
    }),
  );
  await page.route('**/bff/session/activity', route => {
    keepAlives += 1;
    serverEnds = elapsed + 15 * 60 * 1000;
    return route.fulfill({
      status: 200,
      headers: {Date: new Date(base + elapsed).toUTCString()},
      json: {expiresAt: new Date(base + serverEnds).toISOString()},
    });
  });
  await page.clock.install();
  await page.goto('/');
  await expect(accountButton(page)).toBeVisible();
  await page.clock.runFor('10:00');
  await page.mouse.wheel(0, 200);
  await page.getByRole('main').click();

  // The re-read lands during the run below; report a server clearly under a minute from its end.
  elapsed = 14 * 60 * 1000 + 30 * 1000;
  await page.clock.runFor('04:05');
  await expect.poll(() => keepAlives).toBe(1);
  await expect(warning(page)).toBeHidden();
});

for (const theme of ['Light', 'Dark'] as const) {
  test(`given the ${theme} theme, when the idle warning is open, then axe finds no serious or critical WCAG violations (NFR-A11Y-1)`, async ({
    page,
  }) => {
    await signedIn(page);
    await page.getByRole('banner').getByRole('button', {name: 'Theme'}).click();
    await page.getByRole('menuitemradio', {name: theme}).click();
    await expect(page.getByRole('menu')).toBeHidden();
    await page.clock.runFor('14:05');
    await expect(warning(page)).toBeVisible();
    expect(await blockingViolations(page)).toEqual([]);
  });
}

test.describe('given a signed-in clinician who switches away from the app (W-7)', () => {
  test.beforeEach(async ({page}) => {
    await signedIn(page);
  });

  test('when the app is hidden, then a cover hides the whole app, and returning within the grace period lifts it (guards PHI in the recents thumbnail)', async ({
    page,
  }) => {
    await setVisibility(page, 'hidden');
    await expect(page.getByText('Patient data hidden')).toBeVisible();
    await expect(accountButton(page)).toBeHidden();

    await page.clock.runFor('00:20');
    await setVisibility(page, 'visible');
    await expect(page.getByText('Patient data hidden')).toBeHidden();
    await expect(accountButton(page)).toBeVisible();
  });

  test('when the app stays hidden past the grace period, then it signs out through /bff/logout', async ({
    page,
  }) => {
    const sent = await capturePost(page, '/bff/logout');
    await setVisibility(page, 'hidden');

    await page.clock.runFor('01:05');
    await page.waitForURL('**/bff/logout');

    expect(sent()).toMatchObject({
      method: 'POST',
      body: 'reason=idle',
    });
  });
});

test('given "Open another chart?" is open over a chart, when the app is hidden, then the privacy cover is the topmost thing on screen, above the dialog (guards a portalled layer escaping the cover, W-7)', async ({
  page,
}) => {
  await signedIn(page);
  await stubPatientSearch(page, 25);
  await page.goto('/');
  await page.getByRole('textbox', {name: 'Name'}).fill('Testperson');
  await page.getByRole('button', {name: 'Search'}).click();
  const results = page.getByRole('list', {name: 'Search results'});
  await results.getByRole('button', {name: /^Fakey1 Testperson /}).click();
  await page
    .getByRole('banner')
    .getByRole('button', {name: 'Patients'})
    .click();
  await results.getByRole('button', {name: /^Fakey2 Testperson /}).click();
  const dialog = page.getByRole('alertdialog', {name: 'Open another chart?'});
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();

  await setVisibility(page, 'hidden');

  // The element hit at the dialog's centre must belong to the cover (the text's container), not the dialog.
  const point = {
    x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
    y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
  };
  const coverOnTop = await page
    .getByText('Patient data hidden')
    .evaluate((text, {x, y}) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (text.parentElement?.contains(hit) ?? false);
    }, point);
  expect(coverOnTop).toBe(true);
});
