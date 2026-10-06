import {AxeBuilder} from '@axe-core/playwright';
import {errors, expect, type Page} from '@playwright/test';

// The one axe entry point for the E2E suite. Every scan goes through `blockingViolations`, which first
// waits for the page to settle: a scan taken while a menu fades out or a snackbar grows in reads the element at
// partial opacity and reports a `color-contrast` violation that is not there once it has finished.
// reference: REQUIREMENTS.md NFR-A11Y-1

/** WCAG 2.0–2.2, levels A and AA. */
export const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
];

/** Roles MUI mounts for a transition and unmounts when it has faded out. */
const TRANSIENT_ROLES = ['menu', 'listbox', 'dialog', 'alertdialog'] as const;

/** Consecutive quiet polls (50 ms apart) before the page counts as settled. */
const QUIET_POLLS = 3;

/** How long each settle wait may take before it fails with its own message, well inside the test's budget. */
export const SETTLE_TIMEOUT_MS = 5_000;

export interface BlockingViolation {
  readonly id: string;
  readonly impact: 'serious' | 'critical';
  /** axe's one-line summary of the rule, e.g. "Elements must meet minimum color contrast ratio thresholds". */
  readonly help: string;
  readonly targets: readonly string[];
}

/**
 * Waits until nothing on the page is mid-transition: every menu or dialog that is closing has left the page, and
 * no finite CSS transition or animation has run for {@link QUIET_POLLS} polls in a row. Infinite animations (a
 * spinner) never finish, so they are not waited for. Interval polling, not animation frames, so it also works
 * under Playwright's fake clock. Each wait gives up after {@link SETTLE_TIMEOUT_MS}: a finite animation still
 * running then fails with "page did not settle", naming each animation or transition and its element.
 *
 * A menu, listbox, dialog or alertdialog kept mounted while hidden (MUI `keepMounted`, a closed native `<dialog>`)
 * never leaves the page, so every scan fails with "a closing menu has left the page" (or that role). Let it unmount
 * when closed: MUI's default, so drop `keepMounted`, and render a native `<dialog>` only while it is open. If it
 * must stay mounted, change this helper to wait for that element's closing transition to end instead; never skip
 * the wait.
 */
export async function waitForSettled(page: Page): Promise<void> {
  for (const role of TRANSIENT_ROLES) {
    // A closing menu or dialog is hidden from the accessibility tree at once but stays attached while it fades.
    await expect
      .poll(
        async () =>
          (await page.getByRole(role, {includeHidden: true}).count()) -
          (await page.getByRole(role).count()),
        {
          message: `a closing ${role} has left the page`,
          timeout: SETTLE_TIMEOUT_MS,
        },
      )
      .toBe(0);
  }
  await page.evaluate(() => {
    (window as {__axeQuietPolls?: number}).__axeQuietPolls = 0;
  });
  try {
    await page.waitForFunction(
      quietPolls => {
        const moving = document.getAnimations().some(animation => {
          const timing = animation.effect?.getComputedTiming();
          return (
            timing?.iterations !== Infinity &&
            (animation.pending || animation.playState === 'running')
          );
        });
        const state = window as {__axeQuietPolls?: number};
        state.__axeQuietPolls = moving ? 0 : (state.__axeQuietPolls ?? 0) + 1;
        return state.__axeQuietPolls >= quietPolls;
      },
      QUIET_POLLS,
      {polling: 50, timeout: SETTLE_TIMEOUT_MS},
    );
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    const moving = await stillAnimating(page);
    throw new Error(
      `page did not settle within ${String(SETTLE_TIMEOUT_MS)} ms; still animating: ${moving.join(', ') || 'nothing now (it ended just after the timeout)'}`,
      {cause: error},
    );
  }
}

/** Each finite animation or transition still running, as `animation "name" on tag#id.class`, for the error. */
async function stillAnimating(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter(
        animation =>
          animation.effect?.getComputedTiming().iterations !== Infinity &&
          (animation.pending || animation.playState === 'running'),
      )
      .map(animation => {
        const what =
          animation instanceof CSSAnimation
            ? `animation "${animation.animationName}"`
            : animation instanceof CSSTransition
              ? `transition of ${animation.transitionProperty}`
              : 'animation';
        const target =
          animation.effect instanceof KeyframeEffect
            ? animation.effect.target
            : null;
        if (target === null) return what;
        const id = target.id === '' ? '' : `#${target.id}`;
        const classes = [...target.classList]
          .slice(0, 2)
          .map(name => `.${name}`)
          .join('');
        return `${what} on ${target.tagName.toLowerCase()}${id}${classes}`;
      }),
  );
}

/** Serious and critical WCAG A/AA violations on the settled page — a clean page returns `[]`. */
export async function blockingViolations(
  page: Page,
): Promise<BlockingViolation[]> {
  await waitForSettled(page);
  const results = await new AxeBuilder({page}).withTags(WCAG_TAGS).analyze();
  return results.violations.flatMap(v =>
    v.impact === 'serious' || v.impact === 'critical'
      ? [
          {
            id: v.id,
            impact: v.impact,
            help: v.help,
            targets: v.nodes.map(n => n.target.join(' ')),
          },
        ]
      : [],
  );
}
