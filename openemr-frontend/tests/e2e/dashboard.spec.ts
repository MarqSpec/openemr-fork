import {expect, test, type Locator, type Page} from '@playwright/test';

import {
  TEST_PATIENT_ID,
  allergy,
  careTeam,
  condition,
  encounter,
  medicationRequest,
  operationOutcome,
  organization,
  patient,
  practitioner,
  prescription,
  searchBundle,
} from '../../src/test/fhir_fixtures';
import {blockingViolations} from './axe';
import {stubSignedIn} from './bff_stubs';
import {expectDrawnIn} from './theme_look';

// The dashboard route with synthetic FHIR. The local tier has no backend, so Playwright signs a synthetic
// clinician in (bff_stubs.ts) and answers `/bff/fhir/*` itself with the unit tests' synthetic fixtures — every card's
// read and the API-18/19 name reads, so each card draws rows. What is under test here is
// layout — the pinned header, the window-class grid, target sizes, axe — which needs cards with rows, not a
// server; anything that needs OpenEMR's real answers stays in the staging tier.
// `Workspace` mounts the chart for `/patient/:id`.
// reference: REQUIREMENTS.md FR-HDR-1, FR-UI-1, FR-CARD-ALG-1, NFR-UX-1, NFR-A11Y-1, NFR-A11Y-2 · REQUIREMENTS.md W-3, W-4, W-5

/** Material's expanded window class starts at 840 dp (FR-UI-1). */
const EXPANDED_MIN_WIDTH = 840;

/** Enough active problems that the dashboard is taller than either tablet viewport. */
const PROBLEMS = Array.from({length: 40}, (_, index) =>
  condition({
    id: `test-condition-${String(index).padStart(4, '0')}`,
    code: {text: `Test problem ${String(index + 1)}`},
  }),
);

/** One allergy per criticality case (BUG-41), so axe checks the high-criticality highlight in both themes. */
const ALLERGIES = [
  allergy({id: 'test-allergy-0001', criticality: 'high'}),
  allergy({
    id: 'test-allergy-0002',
    code: {text: 'Test substance B'},
    criticality: 'low',
  }),
  allergy({
    id: 'test-allergy-0003',
    code: {text: 'Test substance C'},
    criticality: 'unable-to-assess',
  }),
  allergy({
    id: 'test-allergy-0004',
    code: {text: 'Test substance D'},
    criticality: undefined,
  }),
];

/**
 * An active team and an inactive one (API-17), so axe checks the loaded Care Team tables in both themes:
 * a member and facility named by API-18/19, a member with no read ("Name unavailable"), cells not recorded, and the
 * facility participant OpenEMR adds, which the card leaves out.
 */
const CARE_TEAMS = [
  careTeam({
    participant: [
      {
        role: [{text: 'Test primary role'}],
        member: {
          reference: 'Practitioner/test-practitioner-0001',
          type: 'Practitioner',
        },
        onBehalfOf: {reference: 'Organization/test-org-0001'},
        period: {start: '2025-05-06'},
      },
      {member: {reference: 'RelatedPerson/test-related-0001'}},
      {member: {reference: 'Organization/test-org-0001'}},
    ],
  }),
  careTeam({
    id: 'test-careteam-0002',
    status: 'inactive',
    name: 'Test former care team',
    participant: [
      {
        role: [{text: 'Test former role'}],
        member: {reference: 'Practitioner/test-practitioner-0001'},
      },
    ],
  }),
];

/** API-15 and API-16 are one read: a medication-list entry and a prescription, so both cards have a row. */
const MEDICATION_REQUESTS = [
  medicationRequest(),
  prescription({medicationCodeableConcept: {text: 'Test drug B 20 mg'}}),
];

async function answerFhir(page: Page): Promise<void> {
  await page.route('**/bff/fhir/**', async route => {
    const {pathname} = new URL(route.request().url());
    if (pathname === `/bff/fhir/Patient/${TEST_PATIENT_ID}`) {
      await route.fulfill({json: patient()});
    } else if (pathname === '/bff/fhir/Condition') {
      await route.fulfill({json: searchBundle(PROBLEMS)});
    } else if (pathname === '/bff/fhir/AllergyIntolerance') {
      await route.fulfill({json: searchBundle(ALLERGIES)});
    } else if (pathname === '/bff/fhir/MedicationRequest') {
      await route.fulfill({json: searchBundle(MEDICATION_REQUESTS)});
    } else if (pathname === '/bff/fhir/CareTeam') {
      await route.fulfill({json: searchBundle(CARE_TEAMS)});
    } else if (pathname === '/bff/fhir/Encounter') {
      await route.fulfill({json: searchBundle([encounter()])});
    } else if (pathname === '/bff/fhir/Practitioner/test-practitioner-0001') {
      await route.fulfill({json: practitioner()});
    } else if (pathname === '/bff/fhir/Organization/test-org-0001') {
      await route.fulfill({json: organization()});
    } else {
      await route.fulfill({status: 404, json: operationOutcome('not-found')});
    }
  });
}

async function openDashboard(page: Page): Promise<void> {
  await stubSignedIn(page);
  await answerFhir(page);
  await page.goto(`/patient/${TEST_PATIENT_ID}`);
  await expect(
    page.getByRole('heading', {level: 1, name: 'Fakey Testperson'}),
  ).toBeVisible();
  await expect(
    cardNamed(page, 'Problem List').getByRole('listitem'),
  ).toHaveCount(PROBLEMS.length);
  await expect(cardNamed(page, 'Allergies').getByRole('listitem')).toHaveCount(
    ALLERGIES.length,
  );
  await expect(
    cardNamed(page, 'Medications').getByRole('listitem'),
  ).toHaveCount(MEDICATION_REQUESTS.length);
  await expect(
    cardNamed(page, 'Prescriptions').getByText('Test drug B 20 mg'),
  ).toBeVisible();
  await expect(
    cardNamed(page, 'Encounter History').getByRole('cell', {
      name: 'Testdoctor, Fakedoc',
    }),
  ).toBeVisible();
  await expectCareTeamLoaded(page);
}

/** Both teams' tables, every name read settled: two members and the header, then one member and the header. */
async function expectCareTeamLoaded(page: Page): Promise<void> {
  const tables = cardNamed(page, 'Care Team').getByRole('table');
  await expect(tables).toHaveCount(CARE_TEAMS.length);
  await expect(tables.nth(0).getByRole('row')).toHaveCount(3);
  await expect(tables.nth(1).getByRole('row')).toHaveCount(2);
  const member = tables.nth(0).getByRole('row').nth(1);
  await expect(
    member.getByRole('cell', {name: 'Fakedoc Testdoctor'}),
  ).toBeVisible();
  await expect(member.getByRole('cell', {name: 'Test Clinic'})).toBeVisible();
  await expect(
    tables.nth(0).getByRole('row').nth(2).getByRole('cell', {
      name: 'Name unavailable',
    }),
  ).toBeVisible();
  await expect(cardNamed(page, 'Care Team').getByText(/^Loading/)).toHaveCount(
    0,
  );
}

const header = (page: Page) => page.getByRole('region', {name: 'Patient'});
const cardNamed = (page: Page, name: string) =>
  page.getByRole('region', {name: 'Dashboard'}).getByRole('region', {name});

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('element has no box');
  return found;
}

const isExpanded = (page: Page) =>
  (page.viewportSize()?.width ?? 0) >= EXPANDED_MIN_WIDTH;

test.describe('given a patient dashboard taller than the screen (FR-HDR-1)', () => {
  test('when the cards scroll, then the patient header stays pinned at the top, just under the app bar (guards a header that scrolls away)', async ({
    page,
  }) => {
    await openDashboard(page);
    const bannerBottom = await box(page.getByRole('banner')).then(
      b => b.y + b.height,
    );
    const before = await box(header(page));

    await cardNamed(page, 'Appointments').scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(200);

    await expect(header(page)).toBeInViewport();
    const after = await box(header(page));
    expect(after.y).toBeCloseTo(bannerBottom, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
    const firstCard = await box(cardNamed(page, 'Allergies'));
    expect(firstCard.y).toBeLessThan(after.y);
  });
});

test.describe('given allergies in all four criticality cases (FR-CARD-ALG-1, BUG-41)', () => {
  test('when the dashboard shows, then the high-criticality allergy says so in words, and the others carry their own label or none (guards colour as the only signal)', async ({
    page,
  }) => {
    await openDashboard(page);
    const allergies = cardNamed(page, 'Allergies');

    await expect(
      allergies.getByText('Test substance A (high criticality)'),
    ).toBeVisible();
    await expect(
      allergies.getByText('Test substance B (low criticality)'),
    ).toBeVisible();
    await expect(
      allergies.getByText('Test substance C (criticality not assessed)'),
    ).toBeVisible();
    await expect(
      allergies.getByText('Test substance D', {exact: true}),
    ).toBeVisible();
  });
});

test.describe('given the dashboard layout (FR-UI-1, W-3, W-4)', () => {
  test('when the window is expanded, then Allergies · Problems · Medications share a row, Prescriptions and Care Team are full width, then two columns; when medium, one column in legacy order', async ({
    page,
  }) => {
    await openDashboard(page);
    const main = await box(page.getByRole('region', {name: 'Dashboard'}));
    const [alg, prb, med, rx, ct, enc, vit] = await Promise.all(
      [
        'Allergies',
        'Problem List',
        'Medications',
        'Prescriptions',
        'Care Team',
        'Encounter History',
        'Vitals',
      ].map(name => box(cardNamed(page, name))),
    );
    if (!alg || !prb || !med || !rx || !ct || !enc || !vit) {
      throw new Error('a card is missing');
    }

    if (isExpanded(page)) {
      expect(prb.y).toBeCloseTo(alg.y, 0);
      expect(med.y).toBeCloseTo(alg.y, 0);
      expect(alg.x).toBeLessThan(prb.x);
      expect(prb.x).toBeLessThan(med.x);
      for (const wide of [rx, ct]) {
        expect(wide.width).toBeGreaterThan(main.width * 0.9);
      }
      expect(rx.y).toBeGreaterThan(alg.y);
      expect(ct.y).toBeGreaterThan(rx.y);
      expect(vit.y).toBeCloseTo(enc.y, 0);
      expect(enc.x).toBeLessThan(vit.x);
      expect(enc.y).toBeGreaterThan(ct.y);
    } else {
      const column = [alg, prb, med, rx, ct, enc, vit];
      for (const [index, card] of column.entries()) {
        expect(card.x).toBeCloseTo(alg.x, 0);
        expect(card.width).toBeGreaterThan(main.width * 0.9);
        const previous = column[index - 1];
        if (previous) expect(card.y).toBeGreaterThan(previous.y);
      }
    }
  });

  test('when the dashboard shows, then every control in it is at least 48 × 48 dp (NFR-A11Y-2)', async ({
    page,
  }) => {
    await openDashboard(page);
    const buttons = page
      .getByRole('region', {name: 'Dashboard'})
      .getByRole('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(10);
    for (let index = 0; index < count; index += 1) {
      const target = await box(buttons.nth(index));
      expect(target.height).toBeGreaterThanOrEqual(48);
      expect(target.width).toBeGreaterThanOrEqual(48);
    }
  });

  test('when a card is collapsed, then its rows hide and the other cards stay (FR-CARD-1)', async ({
    page,
  }) => {
    await openDashboard(page);
    const problems = cardNamed(page, 'Problem List');
    const toggle = problems.getByRole('button', {name: 'Problem List'});

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(problems.getByRole('list')).toBeHidden();
    await expect(cardNamed(page, 'Medications')).toBeVisible();
  });
});

for (const theme of ['Light', 'Dark'] as const) {
  test.describe(`given the ${theme} theme (NFR-A11Y-1)`, () => {
    test('when axe scans the dashboard with its header and loaded cards, the Care Team tables included, then it finds no serious or critical WCAG violations (guards contrast, naming and landmark regressions)', async ({
      page,
    }) => {
      await openDashboard(page);
      await page
        .getByRole('banner')
        .getByRole('button', {name: 'Theme'})
        .click();
      await page.getByRole('menuitemradio', {name: theme}).click();
      await expect(page.getByRole('menu')).toBeHidden();
      await expectDrawnIn(page, theme === 'Dark' ? 'dark' : 'light');
      await expectCareTeamLoaded(page);

      expect(await blockingViolations(page)).toEqual([]);
    });
  });
}
