import {expect, test, type Page} from '@playwright/test';

import {
  stubPatientSearch,
  stubSignedIn,
  UNCONFIGURED,
  type RuntimeConfig,
} from './bff_stubs';

// The patient-apps slot (W-13) drawn from the token handler's runtime config, local tier: the built app — the same
// bundle in every environment — shows whichever apps `/bff/config` (API-48) names, and none when it
// names none. /bff/config, /bff/session and the chart's reads are stubbed for layout only (bff_stubs.ts); that the
// token handler serves its PATIENT_APPS is the image smoke test's and the staging spec's.
// reference: REQUIREMENTS.md FR-APP-1, NFR-SEC-1 · INTERFACES.md API-47, API-48 · REQUIREMENTS.md W-13 ·

const PATIENT_ID = 'test-patient-0001';
const LAUNCH = (origin: string) =>
  `${origin}/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient={patientId}`;

async function openChart(page: Page, config: RuntimeConfig): Promise<void> {
  await stubSignedIn(page, config);
  await stubPatientSearch(page, 1);
  await page.goto(`/patient/${PATIENT_ID}`);
  // The slot renders in the same commit as the chart, so once the header's h1 is up its absence is final.
  await expect(
    page
      .getByRole('region', {name: 'Patient', exact: true})
      .getByRole('heading', {level: 1}),
  ).toBeVisible();
}

test.describe('given one build and two token handlers configured differently', () => {
  for (const origin of [
    'https://staging-openemr.example.test',
    'https://production-openemr.example.test',
  ]) {
    test(`when /bff/config names AgentForge at ${origin}, then the chart's slot launches this patient there in a new tab (guards a launch baked into the image for another environment)`, async ({
      page,
    }) => {
      await openChart(page, {
        patientApps: [
          {
            label: 'Launch AgentForge',
            url: LAUNCH(origin),
            aclHint: 'patients/demo',
          },
        ],
        privacyGraceSeconds: 60,
      });

      const slot = page.getByRole('group', {name: 'Patient apps'});
      const link = slot.getByRole('link', {
        name: 'Launch AgentForge — opens in a new tab',
      });
      await expect(link).toHaveAttribute(
        'href',
        LAUNCH(origin).replace('{patientId}', PATIENT_ID),
      );
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(
        slot.getByText('Needs OpenEMR access: patients/demo'),
      ).toBeVisible();
    });
  }

  test('when /bff/config names no apps, then the chart has no Patient apps slot', async ({
    page,
  }) => {
    await openChart(page, UNCONFIGURED);

    await expect(page.getByRole('group', {name: 'Patient apps'})).toHaveCount(
      0,
    );
  });

  test('when /bff/config names an app whose launch URL is not https, then the SPA refuses it too and shows no slot (guards a token handler and SPA that disagree on the rules)', async ({
    page,
  }) => {
    await openChart(page, {
      patientApps: [
        {
          label: 'Launch AgentForge',
          url: 'http://openemr.example.test/launch.php?patient={patientId}',
        },
      ],
      privacyGraceSeconds: 60,
    });

    await expect(page.getByRole('group', {name: 'Patient apps'})).toHaveCount(
      0,
    );
  });
});

test('given a live session, when /bff/config fails, then no chart is drawn: sign-in offers "Try again" (guards PHI on screen with no known privacy grace)', async ({
  page,
}) => {
  await stubSignedIn(page);
  await stubPatientSearch(page, 1);
  await page.route('**/bff/config', route =>
    route.fulfill({status: 503, json: {error: 'unavailable'}}),
  );
  await page.goto(`/patient/${PATIENT_ID}`);

  await expect(page.getByRole('button', {name: 'Try again'})).toBeVisible();
  await expect(
    page.getByRole('region', {name: 'Patient', exact: true}),
  ).toHaveCount(0);
  await expect(page.getByRole('region', {name: 'Dashboard'})).toHaveCount(0);
});
