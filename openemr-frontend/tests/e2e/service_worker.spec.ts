import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {expect, test, type BrowserContext, type Page} from '@playwright/test';

import {blockingViolations} from './axe';
import {CLINICIAN} from './bff_stubs';

// The service worker exists only in the built app, so this spec runs in the `pwa` project against `vite preview`.
// /bff/* is stubbed on the browser context for layout only (bff_stubs.ts has the rule): a context route also sees a
// request a service worker makes, so a worker that started proxying /bff would still be served, and caught by the
// Cache Storage audit rather than by a missing stub. reference: REQUIREMENTS.md FR-PWA-2, FR-PWA-3, FR-PWA-4,
// NFR-SEC-1, NFR-A11Y-1 · REQUIREMENTS.md W-8

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
/** A synthetic patient's family name: what the open chart's header shows. */
const PHI = 'Zzphi-Testperson';

/** The searches the chart's cards make on open (API-13…17, API-20); the FR-PWA-2 spec's own fetches make none. */
const CHART_CARD_READS = [
  '/bff/fhir/AllergyIntolerance',
  '/bff/fhir/Condition',
  '/bff/fhir/MedicationRequest',
  '/bff/fhir/CareTeam',
  '/bff/fhir/Encounter',
];

/** The oracle, read from the build output rather than from the worker: the page and Vite's fingerprinted files. */
function expectedPrecache(): string[] {
  const assets = readdirSync(`${DIST}assets`)
    .filter(name => !name.endsWith('.map'))
    .map(name => `/assets/${name}`);
  return [...assets, '/index.html'].sort();
}

/** Every entry in every cache in the origin's Cache Storage, as path + query. */
async function cacheStorage(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        urls.push(url.pathname + url.search);
      }
    }
    return urls.sort();
  });
}

interface BffStub {
  signedIn: boolean;
  /** A route answers even when the context is offline, so the stub has to fail by itself. */
  connected: boolean;
  readonly reads: string[];
}

async function stubBff(context: BrowserContext): Promise<BffStub> {
  const stub: BffStub = {signedIn: true, connected: true, reads: []};
  await context.route('**/bff/**', async route => {
    if (!stub.connected) {
      await route.abort('internetdisconnected');
      return;
    }
    const url = new URL(route.request().url());
    stub.reads.push(url.pathname);
    if (url.pathname === '/bff/session') {
      await (stub.signedIn
        ? route.fulfill({
            status: 200,
            headers: {'cache-control': 'no-store'},
            json: {
              authenticated: true,
              user: {displayName: CLINICIAN},
              expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              idleTimeoutSeconds: 900,
              grantedScopes: ['openid', 'fhirUser'],
            },
          })
        : route.fulfill({status: 401, json: {error: 'unauthenticated'}}));
      return;
    }
    if (url.pathname === '/bff/logout') {
      stub.signedIn = false;
      await route.fulfill({status: 303, headers: {location: '/signed-out'}});
      return;
    }
    if (url.pathname.startsWith('/bff/fhir/Patient/')) {
      await route.fulfill({
        status: 200,
        headers: {'cache-control': 'no-store'},
        json: {resourceType: 'Patient', id: '1', name: [{family: PHI}]},
      });
      return;
    }
    if (url.pathname.startsWith('/bff/fhir/')) {
      await route.fulfill({
        status: 200,
        headers: {'cache-control': 'no-store'},
        json: {resourceType: 'Bundle', type: 'searchset', entry: []},
      });
      return;
    }
    await route.fulfill({status: 404, json: {error: 'not_found'}});
  });
  return stub;
}

async function setConnected(
  context: BrowserContext,
  stub: BffStub,
  connected: boolean,
): Promise<void> {
  stub.connected = connected;
  await context.setOffline(!connected);
}

/**
 * Makes the worker the browser installs first a marked copy: the build before this one. Playwright routes a worker's
 * registration fetch but not the browser's later update checks, which then find the real build — a new version.
 */
async function installPreviousBuild(context: BrowserContext): Promise<void> {
  await context.route(
    '**/sw.js',
    async route => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: `${await response.text()}\n// previous build\n`,
      });
    },
    {times: 1},
  );
}

/** Loads the app, waits for its worker to activate, then reloads so the page is controlled by it. */
async function openControlled(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
}

const accountButton = (page: Page) =>
  page
    .getByRole('banner')
    .getByRole('button', {name: `Signed in as ${CLINICIAN}`});

test('when a clinician signs in, reads patient data and signs out, then Cache Storage holds exactly the precache and nothing from /bff (guards PHI at rest in the service-worker cache, FR-PWA-2)', async ({
  page,
  context,
}) => {
  const stub = await stubBff(context);
  await openControlled(page);
  await expect(accountButton(page)).toBeVisible();

  // Use: clinical reads under the worker's control, the way a card will make them.
  const bodies = await page.evaluate(async () => {
    const paths = [
      '/bff/fhir/Patient/1',
      '/bff/fhir/Patient/1',
      '/bff/session',
    ];
    const texts: string[] = [];
    for (const path of paths) {
      const response = await fetch(path, {credentials: 'same-origin'});
      texts.push(await response.text());
    }
    return texts;
  });
  expect(bodies[0]).toContain(PHI);
  // And the chart itself: the header and every card read through the worker's page.
  await page.goto('/patient/1');
  await expect(
    page
      .getByRole('region', {name: 'Patient'})
      .getByRole('heading', {level: 1, name: PHI}),
  ).toBeVisible();
  await expect(page.getByRole('region', {name: 'Dashboard'})).toBeVisible();
  // The fetches above never read a card's search, so these can only be the chart's own reads.
  await expect
    .poll(() => stub.reads)
    .toEqual(expect.arrayContaining(CHART_CARD_READS));
  await page.getByRole('button', {name: 'Theme'}).click();
  await page.getByRole('menuitemradio', {name: 'Dark'}).click();

  await accountButton(page).click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await page
    .getByRole('alertdialog', {name: 'Sign out?'})
    .getByRole('button', {name: 'Sign out'})
    .click();
  await page.waitForURL('**/signed-out');
  await expect(page.getByRole('alert')).toContainText("You're signed out");

  const cached = await cacheStorage(page);
  expect(cached.filter(url => /^\/bff/i.test(url))).toEqual([]);
  expect(cached).toEqual(expectedPrecache());
  expect(await page.evaluate(() => caches.keys())).toHaveLength(1);
});

test('when the app is opened with no connection, then the offline shell says so and shows no patient data (FR-PWA-4, W-8)', async ({
  page,
  context,
}) => {
  const stub = await stubBff(context);
  await openControlled(page);
  await expect(accountButton(page)).toBeVisible();
  await page.evaluate(text => {
    const heading = document.createElement('h2');
    heading.textContent = text;
    document.querySelector('main')?.append(heading);
  }, PHI);

  await setConnected(context, stub, false);
  await page.reload();

  await expect(
    page.getByRole('heading', {name: 'No connection'}),
  ).toBeVisible();
  await expect(
    page.getByText("Patient data isn't available offline.", {exact: false}),
  ).toBeVisible();
  await expect(page.getByText(PHI)).toHaveCount(0);
  await expect(accountButton(page)).toHaveCount(0);

  await setConnected(context, stub, true);
  await expect(accountButton(page)).toBeVisible();
});

test('when a new version is deployed mid-session, then "Update available" is offered, nothing swaps until Reload, and Reload activates it (FR-PWA-3)', async ({
  page,
  context,
}) => {
  await stubBff(context);
  await installPreviousBuild(context);
  // The reload that puts the page under the previous build's worker is also the browser's update check.
  await openControlled(page);
  await expect(accountButton(page)).toBeVisible();

  const update = page.getByRole('status').filter({hasText: 'Update available'});
  await expect(update).toBeVisible();
  const waitingState = () =>
    page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.waiting?.state ?? null;
    });
  // Left alone, the new version keeps waiting: the page stays the clinician's, under the old worker.
  await page.waitForTimeout(2000);
  expect(await waitingState()).toBe('installed');
  await expect(accountButton(page)).toBeVisible();

  // Reload is the only thing that activates it: the page reloads once the new worker has taken over.
  await Promise.all([
    page.waitForEvent('load'),
    update.getByRole('button', {name: 'Reload'}).click(),
  ]);

  await expect.poll(waitingState).toBeNull();
  await expect(accountButton(page)).toBeVisible();
  await expect(update).toHaveCount(0);
});

for (const theme of ['Light', 'Dark'] as const) {
  test(`given the ${theme} theme, when axe scans the offline shell and the update prompt, then it finds no serious or critical WCAG violations (NFR-A11Y-1)`, async ({
    page,
    context,
  }) => {
    const stub = await stubBff(context);
    await installPreviousBuild(context);
    await openControlled(page);
    await page.getByRole('button', {name: 'Theme'}).click();
    await page.getByRole('menuitemradio', {name: theme}).click();
    // The menu fades out after the choice. Scanning during that fade fails color-contrast in Dark:
    // the items and the page behind the backdrop are still in the tree, at partial opacity.
    await expect(page.getByRole('menu')).toHaveCount(0);

    await expect(
      page.getByRole('status').filter({hasText: 'Update available'}),
    ).toBeVisible();
    expect(await blockingViolations(page)).toEqual([]);

    await setConnected(context, stub, false);
    await page.reload();
    await expect(
      page.getByRole('heading', {name: 'No connection'}),
    ).toBeVisible();
    expect(await blockingViolations(page)).toEqual([]);
    await setConnected(context, stub, true);
  });
}
