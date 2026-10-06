import {expect, test} from '@playwright/test';

import {
  postForm,
  signInAtOpenemr,
  STAGING_BASE_URL,
  STAGING_PASSWORD,
  STAGING_SKIP_REASON,
  STAGING_USER,
  stagingConfigured,
} from './helpers';

// Staging tier (CONVENTIONS.md): real OpenEMR, real sign-in through the token handler, with the SPA and
// OpenEMR on different sites so OpenEMR's return to /bff/callback is cross-site. Skipped unless the staging URL and
// a synthetic test user come from the environment — never hard-coded, never printed.
// REQUIREMENTS.md FR-BFF-1, FR-BFF-6, FR-AUTH-3, INTERFACES.md API-40, API-41, API-43

test.describe('given the deployed token handler and OpenEMR on different sites (staging)', () => {
  test.skip(!stagingConfigured, STAGING_SKIP_REASON);
  test.setTimeout(120_000);

  test('when the app posts its own sign-in form and the user signs in at OpenEMR, then the cross-site return sets the __Host- session cookie, removes the handshake, and no token reaches the page (guards a Lax handshake that does not survive the cross-site redirect)', async ({
    page,
    context,
  }) => {
    const base = String(STAGING_BASE_URL);
    await page.goto(`${base}/`);
    await postForm(page, '/bff/login');
    await page.waitForURL(url => url.origin !== new URL(base).origin);

    await signInAtOpenemr(page, String(STAGING_USER), String(STAGING_PASSWORD));
    await page.waitForURL(`${base}/`);

    const cookies = await context.cookies(base);
    const session = cookies.find(c => c.name === '__Host-bff-session');
    expect(session).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
    });
    expect(cookies.some(c => c.name === '__Host-bff-handshake')).toBe(false);
    const storage = await page.evaluate(() =>
      [localStorage, sessionStorage]
        .flatMap(store =>
          Array.from({length: store.length}, (_, i) => {
            const key = store.key(i) ?? '';
            return `${key}=${store.getItem(key) ?? ''}`;
          }),
        )
        .join('\n'),
    );
    // A JWT (id_token, access token) starts with a base64url JSON header: eyJ.
    expect(storage).not.toContain('eyJ');
    // OAuth artefacts that must never be stored in the browser (NFR-SEC-1).
    for (const forbidden of [
      'code_verifier',
      'code_challenge',
      'access_token',
      'refresh_token',
      'id_token',
      'client_secret',
    ]) {
      expect(
        storage,
        `web storage must not contain "${forbidden}"`,
      ).not.toContain(forbidden);
    }
    // state and nonce must not be persisted (they pass through URLs only, never stored)
    const lsKeys = await page.evaluate(() =>
      Array.from(
        {length: localStorage.length},
        (_, i) => localStorage.key(i) ?? '',
      ),
    );
    const ssKeys = await page.evaluate(() =>
      Array.from(
        {length: sessionStorage.length},
        (_, i) => sessionStorage.key(i) ?? '',
      ),
    );
    for (const key of [...lsKeys, ...ssKeys]) {
      expect(key, 'storage key must not reference OAuth state').not.toMatch(
        /\bstate\b/i,
      );
      expect(key, 'storage key must not reference nonce').not.toMatch(
        /\bnonce\b/i,
      );
      expect(key, 'storage key must not reference verifier').not.toMatch(
        /\bverifier\b/i,
      );
    }

    await postForm(page, '/bff/logout');
    await page.waitForURL(`${base}/signed-out**`);
    const after = await context.cookies(base);
    expect(after.some(c => c.name === '__Host-bff-session')).toBe(false);
  });

  test('when a page on another site posts to /bff/login, then the token handler refuses it with 403 (guards login CSRF, FR-BFF-6)', async ({
    page,
  }) => {
    const base = String(STAGING_BASE_URL);
    await page.goto(`${base}/`);
    await postForm(page, '/bff/login');
    // Now on OpenEMR's login page: a different site from the token handler.
    await page.waitForURL(url => url.origin !== new URL(base).origin);

    const refused = page.waitForResponse(`${base}/bff/login`);
    await postForm(page, `${base}/bff/login`);

    expect((await refused).status()).toBe(403);
  });
});
