import {expect, test} from '@playwright/test';

import {blockingViolations, waitForSettled} from './axe';

// The shared axe helper itself (following a separate change): how it fails when the page never settles, and what a
// violation carries. Probe pages are set inline with `page.setContent`; nothing here loads the SPA.
// reference: REQUIREMENTS.md NFR-A11Y-1, CONVENTIONS.md Rules

test.describe('given the shared axe helper', () => {
  test('when a finite animation is still running past the settle timeout, then the wait fails on its own timeout naming what is animating (guards a stuck transition surfacing only as a bare test timeout)', async ({
    page,
  }) => {
    await page.setContent(`
      <style>@keyframes probe-fade { from { opacity: 0 } to { opacity: 1 } }</style>
      <div id="stuck" style="animation: probe-fade 600s linear">fading</div>
    `);
    // Well inside the 30 s test budget: the wait's own 5 s limit, plus the time to describe what is moving.
    const started = Date.now();
    await expect(waitForSettled(page)).rejects.toThrow(
      /page did not settle within \d+ ms; still animating: animation "probe-fade" on div#stuck/,
    );
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test('when a menu stays mounted while hidden, then the wait fails saying the closing menu never left the page (guards a keepMounted menu hanging every scan silently)', async ({
    page,
  }) => {
    await page.setContent('<div role="menu" hidden>kept mounted</div>');
    await expect(waitForSettled(page)).rejects.toThrow(
      /a closing menu has left the page/,
    );
  });

  test('when only an infinite animation runs, then the wait settles without it (guards a spinner holding every scan)', async ({
    page,
  }) => {
    await page.setContent(`
      <style>@keyframes probe-spin { to { transform: rotate(360deg) } }</style>
      <div style="animation: probe-spin 1s linear infinite">spinner</div>
    `);
    await waitForSettled(page);
  });

  test('when a scan finds a blocking violation, then it reports the impact and help with the rule and targets (guards a failure that says too little to act on)', async ({
    page,
  }) => {
    await page.setContent(`<!doctype html>
      <html lang="en">
        <head><title>axe helper probe</title></head>
        <body><main><p style="color: #bbb; background: #fff">too pale</p></main></body>
      </html>`);
    expect(await blockingViolations(page)).toContainEqual({
      id: 'color-contrast',
      impact: 'serious',
      help: expect.stringContaining('contrast'),
      targets: ['p'],
    });
  });
});
