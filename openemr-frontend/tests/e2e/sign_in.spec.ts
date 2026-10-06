import {expect, test, type Locator, type Page} from '@playwright/test';

import {capturePost, stubSignedOut} from './bff_stubs';

// W-1 and the signed-out page, local tier: /bff/* stubbed for layout only (bff_stubs.ts); real sign-in is staging's.
// reference: REQUIREMENTS.md FR-AUTH-1, NFR-A11Y-2 · INTERFACES.md API-40 · REQUIREMENTS.md W-1

async function expectTouchTarget(control: Locator): Promise<void> {
  const box = await control.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
}

const signInButton = (page: Page) =>
  page.getByRole('button', {name: 'Sign in with OpenEMR'});

test.describe('given nobody is signed in', () => {
  test.beforeEach(async ({page}) => {
    await stubSignedOut(page);
    await page.goto('/');
  });

  test('when the app loads, then W-1 shows one sign-in action and no credential field (guards a password form in the SPA, FR-AUTH-1)', async ({
    page,
  }) => {
    await expect(
      page.getByRole('heading', {level: 1, name: 'Patient Dashboard'}),
    ).toBeVisible();
    await expect(signInButton(page)).toBeVisible();
    await expect(signInButton(page)).toBeFocused();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
  });

  test('when the sign-in button is measured, then it is at least 48 × 48 dp (guards an undersized touch target, NFR-A11Y-2)', async ({
    page,
  }) => {
    await expectTouchTarget(signInButton(page));
    await expectTouchTarget(
      page.getByRole('banner').getByRole('button', {name: 'Theme'}),
    );
  });

  test('when "Sign in with OpenEMR" is pressed, then the browser navigates with a same-origin form POST to /bff/login and no custom headers (guards a fetch-based sign-in the CSRF guard would refuse)', async ({
    page,
  }) => {
    const sent = await capturePost(page, '/bff/login');

    await signInButton(page).click();
    await page.waitForURL('**/bff/login');

    expect(sent()).toEqual({
      method: 'POST',
      isNavigation: true,
      contentType: 'application/x-www-form-urlencoded',
      body: '',
      authorization: undefined,
    });
  });
});

test.describe('given the token handler sent the browser to /signed-out', () => {
  for (const {reason, text} of [
    {reason: '', text: "You're signed out"},
    {reason: 'idle', text: 'Signed out for inactivity'},
    {reason: 'signin_failed', text: "Sign-in didn't complete"},
    {reason: 'signin_unavailable', text: 'Sign-in is unavailable'},
    {reason: 'signout_partial', text: 'OpenEMR may still be signed in'},
  ]) {
    test(`when the reason is "${reason || '(none)'}", then its fixed notice shows above the sign-in action (guards a missing or wrong explanation)`, async ({
      page,
    }) => {
      await page.goto(reason ? `/signed-out?reason=${reason}` : '/signed-out');

      await expect(page.getByRole('alert')).toContainText(text);
      await expect(signInButton(page)).toBeFocused();
    });
  }

  test('when the reason is markup, then only the generic notice shows and nothing from the URL is rendered (guards reflected input)', async ({
    page,
  }) => {
    await page.goto(
      '/signed-out?reason=%3Cimg%20src%3Dx%20alt%3DZzreflected%3E',
    );

    await expect(page.getByRole('alert')).toContainText("You're signed out");
    await expect(page.getByText('Zzreflected')).toHaveCount(0);
    await expect(page.getByRole('img', {name: 'Zzreflected'})).toHaveCount(0);
  });
});
