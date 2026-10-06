import {expect, test, type Locator, type Page} from '@playwright/test';

import {contrastRatio, renderedColour} from '../../src/theme/contrast';

import {capturePost, CLINICIAN, stubSignedIn} from './bff_stubs';

// The account menu and sign-out confirmation, local tier: /bff/session stubbed for layout only (bff_stubs.ts).
// reference: REQUIREMENTS.md FR-UI-3, FR-UI-7, FR-AUTH-3, NFR-A11Y-2 · INTERFACES.md API-42, API-43 ·
// REQUIREMENTS.md W-9, W-12c

const accountButton = (page: Page) =>
  page
    .getByRole('banner')
    .getByRole('button', {name: `Signed in as ${CLINICIAN}`});

/** Measures once transitions are over: a menu grows in from a scale, so mid-animation boxes are smaller. */
async function expectTouchTarget(control: Locator): Promise<void> {
  await control
    .page()
    .waitForFunction(() => document.getAnimations().length === 0);
  const box = await control.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
}

async function openSignOutDialog(page: Page): Promise<Locator> {
  await accountButton(page).click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  const dialog = page.getByRole('alertdialog', {name: 'Sign out?'});
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('given a signed-in clinician', () => {
  test.beforeEach(async ({page}) => {
    await stubSignedIn(page);
    await page.goto('/');
    await expect(accountButton(page)).toBeVisible();
  });

  test('when the app bar shows, then it names the signed-in clinician and every app-bar control and menu item is at least 48 dp (guards an anonymous app bar and undersized targets)', async ({
    page,
  }) => {
    await expect(accountButton(page)).toContainText(CLINICIAN);
    await expectTouchTarget(accountButton(page));

    await accountButton(page).click();
    await expectTouchTarget(page.getByRole('menuitem', {name: 'Sign out'}));
    // FR-UI-3: the build's version, from package.json (a commit follows when the build knows it).
    const version = page.getByRole('menuitem', {
      name: /^Version v\d+\.\d+\.\d+/,
    });
    await expect(version).toBeVisible();
    // Keyboard and screen-reader focus mode reach it (MUI's MenuList skips disabled items unless told otherwise).
    await expect(page.getByRole('menuitem', {name: 'Sign out'})).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(version).toBeFocused();
  });

  test('when Sign out is chosen, then a modal confirmation opens with Cancel focused, and Escape cancels back to the account button (guards a one-tap sign-out, W-12c)', async ({
    page,
  }) => {
    const dialog = await openSignOutDialog(page);

    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('button', {name: 'Cancel'})).toBeFocused();
    await expectTouchTarget(dialog.getByRole('button', {name: 'Cancel'}));
    await expectTouchTarget(dialog.getByRole('button', {name: 'Sign out'}));

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(accountButton(page)).toBeFocused();
  });

  test('when sign-out is confirmed, then the browser navigates with a same-origin form POST to /bff/logout and no custom headers (guards a fetch-based sign-out that leaves OpenEMR signed in)', async ({
    page,
  }) => {
    const sent = await capturePost(page, '/bff/logout');
    const dialog = await openSignOutDialog(page);

    await dialog.getByRole('button', {name: 'Sign out'}).click();
    await page.waitForURL('**/bff/logout');

    expect(sent()).toEqual({
      method: 'POST',
      isNavigation: true,
      contentType: 'application/x-www-form-urlencoded',
      body: '',
      authorization: undefined,
    });
  });
});

interface FocusLook {
  readonly outlineStyle: string;
  readonly outlineWidth: number;
  readonly outlineColor: string;
  readonly background: string;
  readonly backgroundImage: string;
  readonly menuBackground: string;
  readonly menuBackgroundImage: string;
}

async function lookOf(item: Locator): Promise<FocusLook> {
  return item.evaluate(element => {
    const style = getComputedStyle(element);
    const menu = getComputedStyle(element.closest('.MuiPaper-root') ?? element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      menuBackground: menu.backgroundColor,
      menuBackgroundImage: menu.backgroundImage,
    };
  });
}

/**
 * The lower of the ring's contrast against the surface on either side of it, as rendered: the menu Paper with MUI's
 * dark-mode elevation overlay blended in, and the item's own background over that.
 */
function ringContrast(look: FocusLook): number {
  const ring = renderedColour(look.outlineColor);
  const menu = renderedColour(look.menuBackground, look.menuBackgroundImage);
  const item = renderedColour(menu, look.background, look.backgroundImage);
  return Math.min(contrastRatio(ring, menu), contrastRatio(ring, item));
}

/** Opens the account menu in a theme and moves focus to the Version item, measuring it before and after. */
async function focusVersionItem(
  page: Page,
  theme: 'Light' | 'Dark',
): Promise<{unfocused: FocusLook; focused: FocusLook}> {
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', {name: 'Theme'}).click();
  await page.getByRole('menuitemradio', {name: theme}).click();
  await expect(page.getByRole('menu')).toBeHidden();
  await accountButton(page).click();
  const version = page.getByRole('menuitem', {name: /^Version v/});
  await expect(page.getByRole('menuitem', {name: 'Sign out'})).toBeFocused();
  const unfocused = await lookOf(version);

  await page.keyboard.press('ArrowDown');
  await expect(version).toBeFocused();
  return {unfocused, focused: await lookOf(version)};
}

for (const theme of ['Light', 'Dark'] as const) {
  test(`given the ${theme} theme, when the Arrow keys reach the Version item, then its focus is visible with a 3:1 indicator on the rendered menu surface (guards an invisible focus on a disabled item, WCAG 2.4.7, NFR-A11Y-1)`, async ({
    page,
  }) => {
    await stubSignedIn(page);
    const {unfocused, focused} = await focusVersionItem(page, theme);

    expect(focused.outlineStyle).not.toBe('none');
    expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(
      focused.outlineStyle !== unfocused.outlineStyle ||
        focused.outlineColor !== unfocused.outlineColor ||
        focused.background !== unfocused.background,
    ).toBe(true);
    expect(ringContrast(focused)).toBeGreaterThanOrEqual(3);
  });
}

// A seeded ring the menu's CSS background-color passes (3.51:1 on #212529) but the rendered surface does not: dark
// mode paints MUI's elevation overlay over the Paper, so the menu shows lighter than its background-color.
const SEEDED_LOW_CONTRAST_RING = '#2a78d8';

test('given the Dark theme and a seeded focus ring that is below 3:1 only on the rendered menu surface, when the Arrow keys reach the Version item, then the 3:1 check fails (guards a contrast check that ignores the elevation overlay)', async ({
  page,
}) => {
  await stubSignedIn(page);
  await page.addInitScript(ring => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = `[role="menuitem"]:focus-visible { outline-color: ${ring} !important; }`;
      document.head.append(style);
    });
  }, SEEDED_LOW_CONTRAST_RING);
  const {focused} = await focusVersionItem(page, 'Dark');

  expect(focused.outlineColor).toBe('rgb(42, 120, 216)');
  expect(ringContrast(focused)).toBeLessThan(3);
});
