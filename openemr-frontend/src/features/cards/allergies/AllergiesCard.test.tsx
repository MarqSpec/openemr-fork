import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, within} from '@testing-library/react';
import {delay, http, HttpResponse} from 'msw';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {blockingAxeViolations} from '../../../test/axe';
import {
  TEST_PATIENT_ID,
  allergy,
  operationOutcome,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme, type ThemeMode} from '../../../theme/theme';
import {LIGHT_TOKENS} from '../../../theme/tokens';
import {AllergiesCard} from './AllergiesCard';

// reference: REQUIREMENTS.md FR-CARD-ALG-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// INTERFACES.md API-13 · REQUIREMENTS.md SCR-DASH-ALG · REQUIREMENTS.md BUG-8, BUG-41, BUG-45

const ALLERGIES = '/bff/fhir/AllergyIntolerance';

/** OpenEMR's clinicalStatus (FhirAllergyIntoleranceService): only these three codes are ever sent. */
const clinical = (code: 'active' | 'inactive' | 'resolved') => ({
  coding: [
    {
      system:
        'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
      code,
      display: code.charAt(0).toUpperCase() + code.slice(1),
    },
  ],
});

/**
 * An allergy as OpenEMR sends one: the list title only in the narrative (`createNarrative`, unescaped), `code`
 * the data-absent "Unknown" when no diagnosis code is recorded, and the reaction's list title as manifestation.
 */
function openemrAllergy(
  title: string,
  overrides: Record<string, unknown> = {},
) {
  return allergy({
    text: {
      status: 'additional',
      div: `<div xmlns='http://www.w3.org/1999/xhtml'>${title}</div>`,
    },
    code: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
          code: 'unknown',
          display: 'Unknown',
        },
      ],
    },
    criticality: undefined,
    reaction: undefined,
    ...overrides,
  });
}

function renderCard(
  resources: readonly unknown[],
  options: {mode?: ThemeMode} = {},
) {
  const requests: URL[] = [];
  server.use(
    http.get(ALLERGIES, ({request}) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(searchBundle(resources));
    }),
  );
  const view = render(
    <QueryClientProvider
      client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
    >
      <ThemeProvider theme={createAppTheme(options.mode ?? 'light')}>
        <AllergiesCard patientId={TEST_PATIENT_ID} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return {requests, container: view.container};
}

const region = () => screen.findByRole('region', {name: 'Allergies'});

async function shownAllergies(): Promise<(string | null)[]> {
  const list = await within(await region()).findByRole('list');
  return within(list)
    .getAllByRole('listitem')
    .map(row => row.textContent);
}

describe('given the Allergies read', () => {
  it("when the card loads, then it asks for this patient's allergies and nothing else (API-13: only `patient` is searchable, BUG-8)", async () => {
    const {requests} = renderCard([openemrAllergy('Test substance A')]);
    await within(await region()).findByRole('list');

    expect(requests).toHaveLength(1);
    expect([...(requests[0]?.searchParams.keys() ?? [])]).toEqual(['patient']);
    expect(requests[0]?.searchParams.get('patient')).toBe(TEST_PATIENT_ID);
  });
});

describe('given an allergy as OpenEMR sends it (the title only in the narrative)', () => {
  it('when the card loads, then the row names it by its OpenEMR title, not the data-absent "Unknown" code (SCR-DASH-ALG shows `title`)', async () => {
    renderCard([openemrAllergy('Test substance A')]);

    expect(await shownAllergies()).toEqual(['Test substance A']);
  });

  it('when the title holds markup-like text, then it is shown as the literal text legacy shows, never as markup', async () => {
    renderCard([openemrAllergy('Test <b>substance</b> & co')]);

    expect(await shownAllergies()).toEqual(['Test <b>substance</b> & co']);
    expect(
      within(await region()).queryByText('substance', {selector: 'b'}),
    ).not.toBeInTheDocument();
  });

  it('when it has no narrative but a coded display, then it is named by the coded display', async () => {
    renderCard([
      openemrAllergy('ignored', {
        text: undefined,
        code: {coding: [{system: 'urn:test', code: 'X1', display: 'Coded A'}]},
      }),
    ]);

    expect(await shownAllergies()).toEqual(['Coded A']);
  });

  it('when it has neither a title nor a real code, then the row still appears, named as unnamed (guards a blank row)', async () => {
    renderCard([openemrAllergy('ignored', {text: undefined})]);

    expect(await shownAllergies()).toEqual(['Unnamed allergy']);
  });

  it('when it has a reaction, then the reaction is shown under the substance (FR-CARD-ALG-1; legacy puts it in the tooltip)', async () => {
    renderCard([
      openemrAllergy('Test substance A', {
        reaction: [{manifestation: [{text: 'Test hives'}]}],
      }),
    ]);

    const [row] = within(
      await within(await region()).findByRole('list'),
    ).getAllByRole('listitem');
    if (row === undefined) throw new Error('no allergy row');
    expect(within(row).getByText('Test substance A')).toBeVisible();
    expect(within(row).getByText('Test hives')).toBeVisible();
  });
});

// The four criticality cases OpenEMR sends (BUG-41): severity mild…moderate → low, moderate-to-severe…fatal → high,
// "Unassigned" → unable-to-assess, and no severity → criticality absent.
describe('given allergies in each of the four criticality cases (FR-CARD-ALG-1, BUG-41)', () => {
  it('when criticality is high, then the row says "(high criticality)" in words and is highlighted in the warning style', async () => {
    renderCard([openemrAllergy('Test substance A', {criticality: 'high'})]);

    expect(await shownAllergies()).toEqual([
      'Test substance A (high criticality)',
    ]);
    const flagged = within(await region()).getByText(
      'Test substance A (high criticality)',
    );
    expect(flagged).toHaveStyle({
      backgroundColor: LIGHT_TOKENS.warning,
      fontWeight: '700',
    });
  });

  it('when criticality is low, then the row says "(low criticality)" and is not highlighted', async () => {
    renderCard([openemrAllergy('Test substance B', {criticality: 'low'})]);

    expect(await shownAllergies()).toEqual([
      'Test substance B (low criticality)',
    ]);
    expect(
      within(await region()).getByText('Test substance B (low criticality)'),
    ).not.toHaveStyle({backgroundColor: LIGHT_TOKENS.warning});
  });

  it('when criticality is unable-to-assess (OpenEMR severity "Unassigned"), then the row says "(criticality not assessed)", never "low"', async () => {
    renderCard([
      openemrAllergy('Test substance C', {criticality: 'unable-to-assess'}),
    ]);

    expect(await shownAllergies()).toEqual([
      'Test substance C (criticality not assessed)',
    ]);
  });

  it('when criticality is absent (no severity recorded), then the row has no label and is never shown as low', async () => {
    renderCard([openemrAllergy('Test substance D')]);

    const rows = await shownAllergies();
    expect(rows).toEqual(['Test substance D']);
    expect(rows.join(' ')).not.toContain('criticality');
  });

  it('when a criticality is not one of the FHIR codes, then that allergy is "Could not display this item", in place (FR-CARD-3)', async () => {
    renderCard([
      openemrAllergy('First', {criticality: 'low'}),
      openemrAllergy('Second', {criticality: 'catastrophic'}),
      openemrAllergy('Third'),
    ]);

    expect(await shownAllergies()).toEqual([
      'First (low criticality)',
      expect.stringContaining('Could not display this item'),
      'Third',
    ]);
  });
});

// Legacy lists an allergy whose Outcome is not "Resolved" and whose end date is empty or still to come
// (demographics.php filterActiveIssues). OpenEMR's AllergyIntolerance carries no end date and no Outcome; its
// clinicalStatus is "active" with no end date, "resolved" with Outcome Resolved and an end date, and "inactive"
// for any other end date, past or future (FhirAllergyIntoleranceService.php ~117-122). So the card hides only
// "resolved" — which legacy always hides — and shows the rest, erring toward showing (KNOWN_BUGS BUG-45).
describe('given allergies with and without an end date (review)', () => {
  it('when an allergy has a future end date (OpenEMR sends "inactive"), then it is shown, as the legacy card does', async () => {
    renderCard([
      openemrAllergy('Ends next year', {clinicalStatus: clinical('inactive')}),
    ]);

    expect(await shownAllergies()).toEqual(['Ends next year']);
  });

  it('when an allergy ended with Outcome "Resolved" (OpenEMR sends "resolved"), then it is hidden, as the legacy card hides it', async () => {
    renderCard([
      openemrAllergy('Resolved allergy', {
        clinicalStatus: clinical('resolved'),
      }),
      openemrAllergy('Open allergy', {clinicalStatus: clinical('active')}),
    ]);

    expect(await shownAllergies()).toEqual(['Open allergy']);
  });

  it('when an allergy ended in the past without Outcome "Resolved" (also "inactive" on the wire), then it is shown — FHIR cannot tell it from a future end date, so the card errs toward showing (BUG-45)', async () => {
    renderCard([
      openemrAllergy('Ended last year', {clinicalStatus: clinical('inactive')}),
    ]);

    expect(await shownAllergies()).toEqual(['Ended last year']);
  });

  it('when an allergy is "inactive" and the resource carries no end date (OpenEMR never sends one), then it is shown, as legacy shows an allergy whose end date is still to come', async () => {
    renderCard([
      openemrAllergy('Inactive, no end date', {
        clinicalStatus: clinical('inactive'),
      }),
    ]);

    expect(await shownAllergies()).toEqual(['Inactive, no end date']);
  });

  it('when an allergy has no clinical status, then it is shown, not dropped', async () => {
    renderCard([openemrAllergy('No status', {clinicalStatus: undefined})]);

    expect(await shownAllergies()).toEqual(['No status']);
  });

  it('when an allergy is "active" (no end date), then it is shown whatever its verification status, as legacy ignores verification', async () => {
    renderCard([
      openemrAllergy('Refuted but open', {
        clinicalStatus: clinical('active'),
        verificationStatus: {
          coding: [
            {
              system:
                'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
              code: 'refuted',
            },
          ],
        },
      }),
    ]);

    expect(await shownAllergies()).toEqual(['Refuted but open']);
  });
});

describe('given a patient with no allergies to show', () => {
  it('when the Bundle is empty, then the card shows the legacy "Nothing Recorded" (FR-CARD-4)', async () => {
    renderCard([]);

    expect(
      await within(await region()).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
    expect(within(await region()).queryByRole('list')).not.toBeInTheDocument();
  });

  it('when every allergy is resolved, then the card shows "Nothing Recorded", never "No Known Allergies" — the API does not say the list was reviewed (BUG-46)', async () => {
    renderCard([
      openemrAllergy('Gone', {clinicalStatus: clinical('resolved')}),
    ]);

    const card = await region();
    expect(
      await within(card).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
    expect(
      within(card).queryByText('No Known Allergies'),
    ).not.toBeInTheDocument();
  });
});

describe('given the Allergies read has not answered yet', () => {
  it('when the card renders, then it says it is loading allergies (FR-CARD-1)', async () => {
    server.use(http.get(ALLERGIES, () => delay('infinite')));
    render(
      <QueryClientProvider
        client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
      >
        <ThemeProvider theme={createAppTheme('light')}>
          <AllergiesCard patientId={TEST_PATIENT_ID} />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(
      await within(await region()).findByText('Loading allergies…'),
    ).toBeInTheDocument();
  });
});

describe('given the Allergies read is refused or fails', () => {
  it('when the server answers 403, then the card says the user is not authorised to view allergies (FR-AUTH-5)', async () => {
    server.use(
      http.get(ALLERGIES, () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
      ),
    );
    render(
      <QueryClientProvider
        client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
      >
        <ThemeProvider theme={createAppTheme('light')}>
          <AllergiesCard patientId={TEST_PATIENT_ID} />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    expect(await within(await region()).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view allergies.",
    );
  });

  it('when the server answers 500, then the card says it could not load allergies and offers a retry — never "Nothing Recorded" (guards an outage read as no allergies)', async () => {
    server.use(
      http.get(ALLERGIES, () =>
        HttpResponse.json(operationOutcome('exception'), {status: 500}),
      ),
    );
    render(
      <QueryClientProvider
        client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
      >
        <ThemeProvider theme={createAppTheme('light')}>
          <AllergiesCard patientId={TEST_PATIENT_ID} />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const card = await region();
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      "Couldn't load allergies (server error).",
    );
    expect(
      within(card).getByRole('button', {name: 'Try again'}),
    ).toBeInTheDocument();
    expect(
      within(card).queryByText('Nothing Recorded'),
    ).not.toBeInTheDocument();
  });
});

describe.each(['light', 'dark'] as const)(
  'given the %s theme (NFR-A11Y-1)',
  mode => {
    it('when axe scans the card with all four criticality cases and a malformed item, then it finds no serious or critical violations (the warning highlight included)', async () => {
      const {container} = renderCard(
        [
          openemrAllergy('High A', {
            criticality: 'high',
            reaction: [{manifestation: [{text: 'Test reaction'}]}],
          }),
          openemrAllergy('Low B', {criticality: 'low'}),
          openemrAllergy('Unassessed C', {criticality: 'unable-to-assess'}),
          openemrAllergy('Unlabelled D'),
          openemrAllergy('Broken E', {criticality: 'catastrophic'}),
        ],
        {mode},
      );
      await within(await region()).findByRole('list');

      expect(await blockingAxeViolations(container)).toEqual([]);
    });
  },
);
