import {expect, test, type Page} from '@playwright/test';

import {
  signInThroughBff,
  STAGING_BASE_URL,
  STAGING_PASSWORD,
  STAGING_USER,
  stagingConfigured,
} from './helpers';

// Staging tier (CONVENTIONS.md): the patient-apps slot launches AgentForge from the deployed SPA for the
// open patient, through the module's own uuid-keyed launch — no stubs. Skipped unless the staging URL, a synthetic
// test user, a synthetic demo patient's uuid and the sidecar's origin come from the environment; skips at run time
// when the deployed build renders no "Patient apps" group (built without VITE_PATIENT_APPS, or with an invalid one).
// Never hard-coded, never printed.
// REQUIREMENTS.md FR-APP-1, NFR-SEC-1, NFR-CON-1, INTERFACES.md API-47 ·
// REQUIREMENTS.md BUG-24
const PATIENT_UUID = process.env.STAGING_PATIENT_UUID;
const SIDECAR_ORIGIN = process.env.STAGING_AGENTFORGE_ORIGIN;

const LAUNCH_LINK = {name: 'Launch AgentForge — opens in a new tab'};

/** OpenEMR's own login page, reached outside OAuth, so there is no consent step after it. */
async function signInAtOpenemrLogin(page: Page): Promise<void> {
  await page
    .getByRole('textbox', {name: 'Registered username'})
    .fill(String(STAGING_USER));
  await page.getByPlaceholder('******').fill(String(STAGING_PASSWORD));
  await page.getByRole('button', {name: 'OpenEMR Login'}).click();
}

test.describe('given the deployed SPA built with AgentForge as a patient app (staging)', () => {
  test.skip(
    !stagingConfigured ||
      PATIENT_UUID === undefined ||
      SIDECAR_ORIGIN === undefined,
    'staging tier: set STAGING_BASE_URL, STAGING_OPENEMR_USER, STAGING_OPENEMR_PASSWORD, STAGING_PATIENT_UUID and STAGING_AGENTFORGE_ORIGIN',
  );
  test.setTimeout(180_000);

  test('when the clinician launches AgentForge from the open chart, then a new top-level tab reaches the sidecar with that patient in the launch context, and the SPA stores nothing about it (guards a launch for the wrong patient, FR-APP-1)', async ({
    page,
    context,
  }) => {
    const base = String(STAGING_BASE_URL);
    const uuid = String(PATIENT_UUID);
    await signInThroughBff(page, base);

    await page.goto(`${base}/patient/${encodeURIComponent(uuid)}`);
    // The slot renders in the same commit as the header, so once the header's h1 is up its absence is final.
    await expect(
      page
        .getByRole('region', {name: 'Patient', exact: true})
        .getByRole('heading', {level: 1}),
    ).toBeVisible({timeout: 30_000});
    const slot = page.getByRole('group', {name: 'Patient apps'});
    test.skip(
      (await slot.count()) === 0,
      'staging tier: the deployed SPA renders no "Patient apps" group — rebuild it with the VITE_PATIENT_APPS build arg naming AgentForge (every entry valid)',
    );
    const link = slot.getByRole('link', LAUNCH_LINK);
    const href = String(await link.getAttribute('href'));
    expect(new URL(href).searchParams.get('patient')).toBe(uuid);

    const launched: string[] = [];
    context.on('request', request => {
      if (request.isNavigationRequest()) launched.push(request.url());
    });
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      link.click(),
    ]);
    await tab.waitForLoadState();
    // No OpenEMR session shared with the SPA (BUG-24): sign in there, then launch again from the chart.
    if (new URL(tab.url()).pathname.includes('/interface/login/')) {
      await signInAtOpenemrLogin(tab);
      await tab.waitForLoadState();
      await tab.goto(href);
    }
    await tab.waitForURL(url => url.origin === SIDECAR_ORIGIN, {
      timeout: 60_000,
    });

    // The module's own redirect names the patient in its launch.php hop; that must be the chart's patient.
    const moduleLaunch = launched
      .map(url => new URL(url))
      .find(url => url.pathname.endsWith('/launch.php'));
    expect(moduleLaunch?.searchParams.get('patient')).toBe(uuid);
    expect(await tab.evaluate(() => window.opener === null)).toBe(true);

    // The theme preference may be in localStorage (FR-UI-2); nothing about the patient or the launch may be.
    const stored = await page.evaluate(() =>
      [localStorage, sessionStorage]
        .flatMap(store =>
          Array.from({length: store.length}, (_, i) => {
            const key = store.key(i) ?? '';
            return `${key}=${store.getItem(key) ?? ''}`;
          }),
        )
        .join('\n'),
    );
    expect(stored).not.toContain(uuid);
    expect(stored).not.toContain('launch');
  });
});
