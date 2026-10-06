import {expect, test, type Page} from '@playwright/test';

import {CLINICIAN} from './bff_stubs';

// Sign-out, then Back, with the back/forward cache ON. Playwright disables it by default and its headless shell
// refuses it, so this spec runs only in the `bfcache` project (full Chromium, the switch dropped) against the built
// app (`vite preview`: the dev server's HMR WebSocket would itself keep the page out of the cache). /bff/* is
// stubbed for layout only (bff_stubs.ts has the rule); the token handler's own sign-out is the staging spec's.
// a separate change (note 87776) · REQUIREMENTS.md FR-AUTH-3, NFR-SEC-1 · CONVENTIONS.md (Two tiers)

/** A synthetic patient's family name: what the open chart's header shows. */
const PHI = 'Zzphi-Testperson';

/**
 * How many times a test may sign out and press Back before a page loaded again, not restored, fails it.
 * Chromium can drop a page that was eligible for the cache for reasons outside the page: it empties the cache when
 * the host reports critical memory pressure (`CacheLimitPrunedOnCriticalMemoryPressure`, seen on a Windows laptop
 * with 2 % of its memory free) and evicts on `JavaScriptExecution` (seen once under an 8x CPU throttle). Chromium
 * calls those reasons `Circumstantial`, and only those earn another attempt. A reason the page causes (an unload
 * handler, `no-store`, an open socket) fails at once.
 */
const ATTEMPTS = 3;

/** One reason Chromium gives for not restoring a page from the back/forward cache. */
interface NotRestored {
  readonly type: string;
  readonly reason: string;
}

/** Records the `persisted` flag of every `pageshow` on the page, restored or loaded. */
async function recordPageshow(page: Page): Promise<boolean[]> {
  const restored: boolean[] = [];
  await page.exposeFunction('reportPageshow', (persisted: boolean) => {
    restored.push(persisted);
  });
  await page.addInitScript(() => {
    addEventListener('pageshow', event => {
      (
        window as unknown as {reportPageshow: (p: boolean) => void}
      ).reportPageshow(event.persisted);
    });
  });
  return restored;
}

/** Records every reason Chromium gives for not restoring the page from the back/forward cache. */
async function recordNotRestored(page: Page): Promise<NotRestored[]> {
  const reasons: NotRestored[] = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.backForwardCacheNotUsed', event => {
    reasons.push(...event.notRestoredExplanations);
  });
  await cdp.send('Page.enable');
  return reasons;
}

/** Signs out from the account menu, as a clinician does, and waits for the signed-out screen (W-1b). */
async function signOut(page: Page): Promise<void> {
  await page
    .getByRole('banner')
    .getByRole('button', {name: `Signed in as ${CLINICIAN}`})
    .click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await page
    .getByRole('alertdialog', {name: 'Sign out?'})
    .getByRole('button', {name: 'Sign out'})
    .click();
  await page.waitForURL('**/signed-out');
  await expect(page.getByRole('alert')).toContainText("You're signed out");
}

/**
 * Back loaded the page again instead of restoring it. Passes, so the test signs out and tries again, only when every
 * reason Chromium gave is circumstantial and an attempt is left; otherwise fails with the reasons.
 */
async function expectAnotherAttempt(
  attempt: number,
  notRestored: readonly NotRestored[],
): Promise<void> {
  await expect
    .poll(() => notRestored.length, 'Chromium says why it did not restore')
    .toBeGreaterThan(0);
  const reasons = notRestored.map(r => `${r.type} ${r.reason}`).join(', ');
  expect(
    notRestored.every(r => r.type === 'Circumstantial'),
    `the page kept itself out of the back/forward cache: ${reasons}`,
  ).toBe(true);
  expect(
    attempt,
    `Back loaded the page again on every attempt, never from the back/forward cache (last: ${reasons})`,
  ).toBeLessThan(ATTEMPTS);
}

test('when a clinician signs out and the next person presses Back, then the restored page shows sign-in and no patient data (guards PHI coming back from the back/forward cache)', async ({
  page,
}) => {
  let signedIn = true;
  let sessionReads = 0;
  await page.route('**/bff/session', route => {
    sessionReads += 1;
    return signedIn
      ? route.fulfill({
          status: 200,
          json: {
            authenticated: true,
            user: {displayName: CLINICIAN},
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            idleTimeoutSeconds: 900,
            grantedScopes: ['openid', 'fhirUser'],
          },
        })
      : route.fulfill({status: 401, json: {error: 'unauthenticated'}});
  });
  // The token handler ends the session and (via OpenEMR's end-session) lands the browser on /signed-out.
  await page.route('**/bff/logout', route => {
    signedIn = false;
    return route.fulfill({status: 303, headers: {location: '/signed-out'}});
  });
  // The chart reads its patient (API-12); every card's search answers an empty Bundle.
  await page.route('**/bff/fhir/**', route =>
    new URL(route.request().url()).pathname ===
    '/bff/fhir/Patient/test-patient-0001'
      ? route.fulfill({
          json: {
            resourceType: 'Patient',
            id: 'test-patient-0001',
            name: [{family: PHI, given: ['Fakey']}],
          },
        })
      : route.fulfill({
          json: {resourceType: 'Bundle', type: 'searchset', entry: []},
        }),
  );
  const restored = await recordPageshow(page);
  const notRestored = await recordNotRestored(page);

  for (let attempt = 1; ; attempt += 1) {
    signedIn = true;
    await page.goto('/patient/test-patient-0001');
    await expect(
      page
        .getByRole('banner')
        .getByRole('button', {name: `Signed in as ${CLINICIAN}`}),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', {name: 'Patient'})
        .getByRole('heading', {level: 1, name: `Fakey ${PHI}`}),
    ).toBeVisible();

    await signOut(page);
    restored.length = 0;
    notRestored.length = 0;
    const readsBeforeBack = sessionReads;

    // A restore fires no load event, so wait only for the navigation to commit, then for the page to show.
    await page.goBack({waitUntil: 'commit'});
    await expect.poll(() => restored.length).toBeGreaterThan(0);

    // Restored or loaded again, the page shows sign-in and nothing of the patient.
    await expect(
      page.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toBeVisible();
    await expect(page.getByText(PHI)).toHaveCount(0);
    await expect(page.getByRole('region', {name: 'Dashboard'})).toHaveCount(0);
    await expect(
      page.getByRole('button', {name: `Signed in as ${CLINICIAN}`}),
    ).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(sessionReads).toBeGreaterThan(readsBeforeBack);

    // Proves the cache was in play: without it this test would pass for the wrong reason.
    if (restored[0] === true) break;
    await expectAnotherAttempt(attempt, notRestored);
  }
});

// the same guard with the service worker in play. A worker-controlled page is a different bfcache candidate
// (the worker, not the page, may answer the navigation), so the case above alone does not prove this one. The stubs
// sit on the browser context, which also sees a request the worker makes (service_worker.spec.ts has the rule).
test('when the service worker controls the page, a clinician signs out and the next person presses Back, then the restored page shows sign-in and no patient data (guards PHI coming back from the back/forward cache past the worker)', async ({
  context,
  page,
}) => {
  let signedIn = true;
  let sessionReads = 0;
  await context.route('**/bff/session', route => {
    sessionReads += 1;
    return signedIn
      ? route.fulfill({
          status: 200,
          json: {
            authenticated: true,
            user: {displayName: CLINICIAN},
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            idleTimeoutSeconds: 900,
            grantedScopes: ['openid', 'fhirUser'],
          },
        })
      : route.fulfill({status: 401, json: {error: 'unauthenticated'}});
  });
  await context.route('**/bff/logout', route => {
    signedIn = false;
    return route.fulfill({status: 303, headers: {location: '/signed-out'}});
  });
  const restored = await recordPageshow(page);
  const notRestored = await recordNotRestored(page);

  // The worker never claims an open page (FR-PWA-3), so it controls the one loaded after it activates.
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const controlled = () =>
    page.evaluate(() => navigator.serviceWorker.controller !== null);

  for (let attempt = 1; ; attempt += 1) {
    signedIn = true;
    await page.goto('/');
    await expect.poll(controlled).toBe(true);
    await expect(
      page
        .getByRole('banner')
        .getByRole('button', {name: `Signed in as ${CLINICIAN}`}),
    ).toBeVisible();
    await page.evaluate(text => {
      const heading = document.createElement('h2');
      heading.textContent = text;
      document.querySelector('main')?.append(heading);
    }, PHI);
    await expect(page.getByText(PHI)).toBeVisible();

    await signOut(page);
    restored.length = 0;
    notRestored.length = 0;
    const readsBeforeBack = sessionReads;

    await page.goBack({waitUntil: 'commit'});
    await expect.poll(() => restored.length).toBeGreaterThan(0);

    // Restored or loaded again, the page shows sign-in and nothing of the patient, and the worker still controls it.
    await expect(
      page.getByRole('button', {name: 'Sign in with OpenEMR'}),
    ).toBeVisible();
    await expect.poll(controlled).toBe(true);
    await expect(page.getByText(PHI)).toHaveCount(0);
    await expect(
      page.getByRole('button', {name: `Signed in as ${CLINICIAN}`}),
    ).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(sessionReads).toBeGreaterThan(readsBeforeBack);

    // Proves the cache was in play: without it this test would pass for the wrong reason.
    if (restored[0] === true) break;
    await expectAnotherAttempt(attempt, notRestored);
  }
});
