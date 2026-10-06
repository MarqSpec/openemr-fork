import {expect, test, type BrowserContext} from '@playwright/test';

import {
  signInThroughBff,
  signOutThroughBff,
  STAGING_BASE_URL,
  STAGING_SKIP_REASON,
  stagingConfigured,
  usePatientSearch,
} from './helpers';
import {
  assertAllowedLocalStorageKeys,
  assertNoClinical,
  assertNoForbidden,
  dumpCacheBodies,
  dumpIndexedDb,
  dumpWebStorage,
} from './storage_audit';

// Storage audit (NFR-SEC-1): after sign-in, use and sign-out, no PHI, no token and no OAuth
// artefact in web storage or Cache Storage. Staging only — the browser talks to the real token handler
// and real OpenEMR. Skipped unless STAGING_BASE_URL and credentials are set.
// reference: REQUIREMENTS.md NFR-SEC-1, FR-BFF-1, FR-BFF-2, CONVENTIONS.md

/** All cookies for the base URL. */
async function getCookies(
  context: BrowserContext,
  baseUrl: string,
): Promise<{name: string; value: string}[]> {
  return (await context.cookies(baseUrl)).map(c => ({
    name: c.name,
    value: c.value,
  }));
}

test.describe('storage audit after sign-in, use and sign-out (NFR-SEC-1)', () => {
  test.skip(!stagingConfigured, STAGING_SKIP_REASON);
  test.setTimeout(180_000);

  test('when a user signs in, searches a patient, browses and signs out, then no PHI or token remains in web storage or IndexedDB (guards NFR-SEC-1 — no PHI at rest on the device)', async ({
    page,
  }) => {
    const base = String(STAGING_BASE_URL);

    await signInThroughBff(page, base);

    const clinicalSamples = await usePatientSearch(page);

    const session = await page.evaluate(async () => {
      const resp = await fetch('/bff/session', {credentials: 'include'});
      return resp.json() as Promise<Record<string, unknown>>;
    });
    expect(session).toHaveProperty('authenticated', true);

    const storageDuring = await dumpWebStorage(page);
    assertNoForbidden('web storage during session', storageDuring);
    assertNoClinical(
      'web storage during session',
      storageDuring,
      clinicalSamples,
    );

    const idbDuring = await dumpIndexedDb(page);
    assertNoForbidden('IndexedDB during session', idbDuring);
    assertNoClinical('IndexedDB during session', idbDuring, clinicalSamples);

    await signOutThroughBff(page);

    const storageAfter = await dumpWebStorage(page);
    assertNoForbidden('web storage after sign-out', storageAfter);
    assertNoClinical(
      'web storage after sign-out',
      storageAfter,
      clinicalSamples,
    );

    await assertAllowedLocalStorageKeys(page);

    const ssLength = await page.evaluate(() => sessionStorage.length);
    expect(ssLength, 'sessionStorage must be empty after sign-out').toBe(0);

    const idbAfter = await dumpIndexedDb(page);
    assertNoForbidden('IndexedDB after sign-out', idbAfter);
    assertNoClinical('IndexedDB after sign-out', idbAfter, clinicalSamples);
  });

  test('when a user signs in, searches a patient and signs out, then Cache Storage holds no clinical or /bff data (guards FR-PWA-2 — no API data cached)', async ({
    page,
  }) => {
    const base = String(STAGING_BASE_URL);

    await signInThroughBff(page, base);
    const clinicalSamples = await usePatientSearch(page);
    await signOutThroughBff(page);

    const bodies = await dumpCacheBodies(page);
    for (const [i, body] of bodies.entries()) {
      assertNoForbidden(`cache body ${String(i)}`, body);
      assertNoClinical(`cache body ${String(i)}`, body, clinicalSamples);
      expect(body, 'cache must not hold /bff responses').not.toMatch(
        /"authenticated"\s*:/,
      );
    }
  });

  test('when a user signs in, then no cookie contains a token or PKCE verifier (guards FR-BFF-2 — tokens server-side only)', async ({
    page,
    context,
  }) => {
    const base = String(STAGING_BASE_URL);

    await signInThroughBff(page, base);

    const cookies = await getCookies(context, base);
    for (const cookie of cookies) {
      assertNoForbidden(`cookie "${cookie.name}"`, cookie.value);
    }

    expect(cookies.some(c => c.name === '__Host-bff-handshake')).toBe(false);

    await signOutThroughBff(page);

    const afterCookies = await getCookies(context, base);
    expect(afterCookies.some(c => c.name === '__Host-bff-session')).toBe(false);
  });

  test('when a user signs in and reads /bff/session, then the response body contains no access or refresh token (guards token leaking to the browser)', async ({
    page,
  }) => {
    const base = String(STAGING_BASE_URL);

    await signInThroughBff(page, base);

    const sessionRead = page.waitForResponse(
      r => r.url().includes('/bff/session') && r.request().method() === 'GET',
    );
    await page.evaluate(() => fetch('/bff/session', {credentials: 'include'}));
    const body = await (await sessionRead).text();
    expect(
      body.length,
      'must read at least one /bff/session body',
    ).toBeGreaterThan(0);
    expect(body, '/bff response must not contain access_token').not.toMatch(
      /"access_token"\s*:/,
    );
    expect(body, '/bff response must not contain refresh_token').not.toMatch(
      /"refresh_token"\s*:/,
    );
    expect(body, '/bff response must not contain client_secret').not.toMatch(
      /"client_secret"\s*:/,
    );

    await signOutThroughBff(page);
  });
});
