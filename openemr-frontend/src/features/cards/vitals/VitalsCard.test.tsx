import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {delay, http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {blockingAxeViolations} from '../../../test/axe';
import {
  DEMO_VITALS,
  TEST_ENCOUNTER_ID,
  TEST_PATIENT_ID,
  operationOutcome,
  quantity,
  searchBundle,
  vitalComponent,
  vitalSign,
  vitalValue,
  vitalsForm,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme} from '../../../theme/theme';
import {VitalsCard} from './VitalsCard';

// reference: REQUIREMENTS.md FR-CARD-VIT-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// INTERFACES.md API-21 · REQUIREMENTS.md SCR-DASH-VIT · REQUIREMENTS.md BUG-7, BUG-34, BUG-35, BUG-51,
// BUG-54, BUG-55 · REQUIREMENTS.md W-3, W-5

/** 2026-09-25, mid-afternoon local time: "today" for the date window. */
const NOW = () => new Date(2026, 8, 25, 15, 0);

/** The first window: 12 months back from NOW. */
const FIRST = 'ge2025-09-25';
/** After one "Show older vitals". */
const SECOND = 'ge2024-09-25';

const OTHER_PATIENT_ID = 'test-patient-0002';

interface Answers {
  /** Observations by the `date` bound the card sends; a bound not listed answers an empty Bundle. */
  readonly vitals?: Readonly<Record<string, readonly unknown[]>>;
  readonly response?: () => Response | Promise<Response>;
}

function answer(answers: Answers = {}) {
  const searches: URL[] = [];
  server.use(
    http.get('/bff/fhir/Observation', ({request}) => {
      const url = new URL(request.url);
      searches.push(url);
      if (answers.response) return answers.response();
      const bound = url.searchParams.get('date') ?? '';
      return HttpResponse.json(searchBundle(answers.vitals?.[bound] ?? []));
    }),
  );
  return {searches};
}

function renderCard(patientId = TEST_PATIENT_ID) {
  const onSessionOver = vi.fn();
  const client = createQueryClient({onSessionOver, retryDelayMs: 0});
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={client}>
      <ThemeProvider theme={createAppTheme('light')}>{ui}</ThemeProvider>
    </QueryClientProvider>
  );
  const view = render(wrap(<VitalsCard patientId={patientId} clock={NOW} />));
  return {
    onSessionOver,
    container: view.container,
    /** Re-renders the card for `id`, as the dashboard does on a patient switch. */
    showPatient: (id: string) => {
      view.rerender(wrap(<VitalsCard patientId={id} clock={NOW} />));
    },
  };
}

const card = () => screen.getByRole('region', {name: 'Vitals'});

/** The set's rows as [label, value], top to bottom. */
async function shownRows(): Promise<string[][]> {
  const table = await within(card()).findByRole('table');
  return within(table)
    .getAllByRole('row')
    .map(row => [
      within(row).getByRole('rowheader').textContent,
      within(row).getByRole('cell').textContent,
    ]);
}

const SEPT_10 = '2026-09-10T09:00:00-04:00';
const JUNE_1 = '2026-06-01T09:00:00-04:00';
const OTHER_ENCOUNTER_ID = 'test-encounter-0002';

/** The seeded form's rows, as the card shows them. */
const DEMO_ROWS = [
  ['Blood Pressure', '134/84'],
  ['Weight', '208 lb (94.35 kg)'],
  ['Height', '70 in (177.80 cm)'],
  ['Temperature', '98.2 F (36.78 C)'],
  ['Pulse', '86 per min'],
  ['Respiration', '16 per min'],
];

/** A form's observations with `status` on every one, or only on the one with id `only`. */
function withStatus(
  form: readonly Record<string, unknown>[],
  status: string,
  only?: string,
): Record<string, unknown>[] {
  return form.map(observation =>
    only === undefined || observation.id === only
      ? {...observation, status}
      : observation,
  );
}

describe('given the Vitals read (API-21)', () => {
  it('when the card loads, then it asks for this patient’s vital signs from 12 months ago and nothing else — no code, paging or sort (BUG-7)', async () => {
    const {searches} = answer({vitals: {[FIRST]: vitalsForm(SEPT_10, 'a')}});
    renderCard();
    await shownRows();

    expect(searches).toHaveLength(1);
    const params = searches[0]?.searchParams;
    expect(params?.get('patient')).toBe(TEST_PATIENT_ID);
    expect(params?.get('category')).toBe('vital-signs');
    expect(params?.getAll('date')).toEqual([FIRST]);
    expect([...(params?.keys() ?? [])].sort()).toEqual([
      'category',
      'date',
      'patient',
    ]);
  });
});

describe('given a seeded demo patient’s vitals form (SCR-DASH-VIT)', () => {
  it('when the card loads, then it reads "Most recent vitals from:" the form’s date and time, then each recorded vital as legacy labels and formats it, in legacy order', async () => {
    answer({vitals: {[FIRST]: vitalsForm(SEPT_10, 'a')}});
    renderCard();

    expect(
      await within(card()).findByText(
        'Most recent vitals from: 2026-09-10 09:00:00',
      ),
    ).toBeInTheDocument();
    expect(await shownRows()).toEqual([
      ['Blood Pressure', '134/84'],
      ['Weight', '208 lb (94.35 kg)'],
      ['Height', '70 in (177.80 cm)'],
      ['Temperature', '98.2 F (36.78 C)'],
      ['Pulse', '86 per min'],
      ['Respiration', '16 per min'],
    ]);
  });

  it('when OpenEMR sends a null placeholder for every vital the form did not record, then none of them is a row (BUG-34)', async () => {
    answer({vitals: {[FIRST]: vitalsForm(SEPT_10, 'a')}});
    renderCard();

    const labels = (await shownRows()).map(([label]) => label);
    for (const absent of [
      'BMI',
      'Oxygen Saturation',
      'Head Circ',
      'Temp Method',
      'Pediatric BMI Percentile',
    ]) {
      expect(labels).not.toContain(absent);
    }
    expect(within(card()).queryByText(/unknown/i)).not.toBeInTheDocument();
  });

  it('when the set has a table, then the table is named for the set, so a screen reader hears what it holds', async () => {
    answer({vitals: {[FIRST]: vitalsForm(SEPT_10, 'a')}});
    renderCard();

    expect(await within(card()).findByRole('table')).toHaveAccessibleName(
      'Most recent vitals from: 2026-09-10 09:00:00',
    );
  });
});

describe('given more than one vitals form in the window (FR-CARD-VIT-1)', () => {
  it('when the server sends the older form first, then only the newest form’s values are shown', async () => {
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm('2026-06-01T09:00:00-04:00', 'old', {
            ...DEMO_VITALS,
            bps: 142,
            bpd: 88,
          }),
          ...vitalsForm(SEPT_10, 'new'),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toContainEqual(['Blood Pressure', '134/84']);
    expect(within(card()).queryByText('142/88')).not.toBeInTheDocument();
    expect(
      within(card()).getByText('Most recent vitals from: 2026-09-10 09:00:00'),
    ).toBeInTheDocument();
  });

  it('when the forms’ times carry different offsets, then the newest is the latest wall-clock time OpenEMR recorded, not the latest instant (BUG-35, BUG-51)', async () => {
    // As instants, 23:30 at -04:00 (03:30Z next day) is later than 01:00 at +00:00; as recorded, 09-11 01:00 is later.
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm('2026-09-11T01:00:00+00:00', 'later', {
            ...DEMO_VITALS,
            pulse: 61,
          }),
          ...vitalsForm('2026-09-10T23:30:00-04:00', 'earlier', {
            ...DEMO_VITALS,
            pulse: 99,
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toContainEqual(['Pulse', '61 per min']);
    expect(
      within(card()).getByText('Most recent vitals from: 2026-09-11 01:00:00'),
    ).toBeInTheDocument();
  });
});

describe('given every vital OpenEMR can send', () => {
  const FULL = [
    vitalSign('85353-1', {
      id: 'panel',
      dataAbsentReason: undefined,
      note: [{text: 'Test note: taken seated'}],
    }),
    vitalValue('29463-7', quantity(94.3472, 'kg')),
    vitalValue('8302-2', quantity(177.8, 'cm')),
    vitalValue('8310-5', quantity(36.8, 'Cel')),
    vitalSign('8327-9', {dataAbsentReason: undefined, valueString: 'Oral'}),
    vitalValue('39156-5', quantity(24.2, 'kg/m2')),
    vitalValue('9843-4', quantity(56, 'cm')),
    // OpenEMR sends the same oximetry twice, as 2708-6 and as 59408-5, each coded with both (BUG-55).
    ...['2708-6', '59408-5'].map(code =>
      vitalValue(code, quantity(97, '%'), {
        id: `ox-${code}`,
        code: {
          text: 'oxygen_saturation',
          coding: [
            {system: 'http://loinc.org', code: '2708-6'},
            {system: 'http://loinc.org', code: '59408-5'},
          ],
        },
        component: [
          vitalComponent('3151-8', quantity(2, 'L/min')),
          vitalComponent('3150-0', quantity(28, '%')),
        ],
      }),
    ),
    vitalValue('77606-2', quantity(40, '%')),
    vitalValue('59576-9', quantity(55, '%')),
    vitalValue('8289-1', quantity(60, '%')),
    // The calculated mean blood pressure (BUG-34): never shown.
    vitalSign('96607-7', {
      dataAbsentReason: undefined,
      component: [
        vitalComponent('96608-5', quantity(130, 'mm[Hg]')),
        vitalComponent('96609-3', quantity(80, 'mm[Hg]')),
      ],
    }),
  ];

  it('when a form records them in metric, then each is shown in its unit with the other system beside it, legacy’s labels and order, the oximetry once, and no mean blood pressure (BUG-34, BUG-55)', async () => {
    answer({vitals: {[FIRST]: FULL}});
    renderCard();

    expect(await shownRows()).toEqual([
      ['Weight', '94.35 kg (208.00 lb)'],
      ['Height', '177.8 cm (70.00 in)'],
      ['Temperature', '36.8 C (98.24 F)'],
      ['Temp Method', 'Oral'],
      ['Note', 'Test note: taken seated'],
      ['BMI', '24.2 kg/m²'],
      ['Head Circ', '56 cm (22.05 in)'],
      ['Oxygen Saturation', '97 %'],
      ['Oxygen Flow Rate', '2 L/min'],
      ['Pediatric Height Weight Percentile', '40 %'],
      ['Pediatric BMI Percentile', '55 %'],
      ['Pediatric Head Circumference Percentile', '60 %'],
      ['Inhaled Oxygen Concentration', '28 %'],
    ]);
  });

  it('when a blood pressure has one side missing, then the side that was recorded is still shown', async () => {
    answer({
      vitals: {
        [FIRST]: [
          vitalSign('85354-9', {
            dataAbsentReason: undefined,
            component: [
              vitalComponent('8480-6', quantity(128, 'mm[Hg]')),
              vitalComponent('8462-4', undefined),
            ],
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([['Blood Pressure', '128/—']]);
  });

  it('when OpenEMR sends a vital this card does not know, with a value, then it is shown under OpenEMR’s own name for it rather than dropped', async () => {
    answer({
      vitals: {
        [FIRST]: [
          vitalValue('8867-4', quantity(70, '/min')),
          vitalValue('8280-0', quantity(34.5, 'in_i', '[in_i]'), {
            code: {
              coding: [
                {
                  system: 'http://loinc.org',
                  code: '8280-0',
                  display: 'Waist Circumference at umbilicus by Tape measure',
                },
              ],
            },
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([
      ['Pulse', '70 per min'],
      [
        'Waist Circumference at umbilicus by Tape measure',
        '34.5 in (87.60 cm)',
      ],
    ]);
  });

  it('when the newest form has no values at all, then it still names that form’s date and says nothing was recorded in it, as legacy shows an empty set', async () => {
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm('2026-06-01T09:00:00-04:00', 'old'),
          vitalSign('85353-1', {
            id: 'empty-panel',
            dataAbsentReason: undefined,
          }),
          vitalSign('8867-4', {id: 'empty-pulse'}),
        ],
      },
    });
    renderCard();

    expect(
      await within(card()).findByText(
        'Most recent vitals from: 2026-09-10 09:00:00',
      ),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText('No values were recorded in this set.'),
    ).toBeInTheDocument();
    expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('given the card’s states (FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5)', () => {
  it('when the read is in flight, then the card is busy and says it is loading vitals', async () => {
    answer({
      response: async () => {
        await delay('infinite');
        return HttpResponse.json(searchBundle([]));
      },
    });
    renderCard();

    expect(
      await within(card()).findByText('Loading vitals…'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText('Loading vitals…').closest('[aria-busy]'),
    ).toHaveAttribute('aria-busy', 'true');
  });

  it('when there are no vitals in the window, then it says none were documented since the window’s start and offers to look further back (legacy has no window)', async () => {
    answer();
    renderCard();

    expect(
      await within(card()).findByText(
        'No vitals have been documented since 2025-09-25.',
      ),
    ).toBeInTheDocument();
    expect(
      within(card()).getByRole('button', {name: 'Show older vitals'}),
    ).toBeInTheDocument();
  });

  it('when the read is refused (403), then it says the user is not authorised, with no retry', async () => {
    answer({
      response: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view vitals. Access is controlled in OpenEMR.",
    );
    expect(
      within(card()).queryByRole('button', {name: 'Try again'}),
    ).not.toBeInTheDocument();
    expect(
      within(card()).queryByRole('button', {name: 'Show older vitals'}),
    ).not.toBeInTheDocument();
  });

  it('when the read fails on the server, then it says so with "Try again", which reloads the vitals', async () => {
    let fail = true;
    answer({
      response: () =>
        fail
          ? HttpResponse.json(operationOutcome('exception'), {status: 500})
          : HttpResponse.json(searchBundle(vitalsForm(SEPT_10, 'a'))),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load vitals (server error).",
    );
    fail = false;
    await userEvent.click(
      within(card()).getByRole('button', {name: 'Try again'}),
    );
    expect(await shownRows()).toContainEqual(['Pulse', '86 per min']);
  });

  it('when the session is over (401), then the card shows nothing of the patient and the app is told', async () => {
    answer({
      response: () =>
        HttpResponse.json(operationOutcome('login'), {status: 401}),
    });
    const {onSessionOver} = renderCard();

    await waitFor(() => {
      expect(onSessionOver).toHaveBeenCalledOnce();
    });
    expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
    expect(within(card()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('when one observation is malformed, then it is a "Could not display this item" line and the set still shows (FR-CARD-3)', async () => {
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm(SEPT_10, 'a'),
          {resourceType: 'Observation', id: 'bad', status: 'not-a-status'},
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toContainEqual(['Pulse', '86 per min']);
    expect(
      within(card()).getByText('Could not display this item'),
    ).toBeInTheDocument();
  });

  it('when an observation with a value has no time, then it cannot join a set and is a "Could not display this item" line, never dropped (FR-CARD-3)', async () => {
    // No `effectiveDateTime` in the body: OpenEMR sends only a data-missing extension for a form with no date.
    const undated = vitalValue('8867-4', quantity(70, '/min'), {
      id: 'undated',
      effectiveDateTime: undefined,
    });
    answer({vitals: {[FIRST]: [...vitalsForm(SEPT_10, 'a'), undated]}});
    renderCard();

    expect(await shownRows()).toContainEqual(['Pulse', '86 per min']);
    expect(
      within(card()).getByText('Could not display this item'),
    ).toBeInTheDocument();
  });

  it('when the card shows a set, then axe finds no serious or critical violations (NFR-A11Y-1)', async () => {
    answer({vitals: {[FIRST]: vitalsForm(SEPT_10, 'a')}});
    const {container} = renderCard();
    await shownRows();

    expect(await blockingAxeViolations(container)).toEqual([]);
  });
});

describe('given a vitals search that says it holds more than it sent (BUG-7)', () => {
  it('when a set is shown, then "More vitals not shown" is visible and the heading does not claim this is the most recent', async () => {
    answer({
      response: () =>
        HttpResponse.json({
          ...searchBundle(vitalsForm(SEPT_10, 'a')),
          total: 40,
        }),
    });
    renderCard();

    expect(await shownRows()).toContainEqual(['Pulse', '86 per min']);
    expect(
      within(card()).getByText(
        'Vitals from: 2026-09-10 09:00:00 (more not shown; this may not be the most recent)',
      ),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText('More vitals not shown'),
    ).toBeInTheDocument();
    expect(within(card()).queryByText(/^Most recent vitals from:/)).toBeNull();
    expect(
      within(card()).queryByText('Could not display this item'),
    ).toBeNull();
  });

  it('when no observation came back, then it does not say none have been documented, and it says more vitals are not shown', async () => {
    answer({
      response: () => HttpResponse.json({...searchBundle([]), total: 2}),
    });
    renderCard();

    expect(
      await within(card()).findByText('More vitals not shown'),
    ).toBeInTheDocument();
    expect(
      within(card()).queryByText(/No vitals have been documented/),
    ).toBeNull();
    expect(within(card()).queryByText(/Most recent vitals from:/)).toBeNull();
    expect(
      within(card()).queryByRole('button', {name: 'Show older vitals'}),
    ).not.toBeInTheDocument();
    expect(
      within(card()).queryByText('Could not display this item'),
    ).toBeNull();
  });

  it('when one observation does not parse, then that line stays "Could not display this item" and the partial result is worded apart', async () => {
    answer({
      response: () =>
        HttpResponse.json({
          ...searchBundle([
            ...vitalsForm(SEPT_10, 'a'),
            {resourceType: 'Observation', id: 'bad', status: 'not-a-status'},
          ]),
          total: 40,
        }),
    });
    renderCard();

    expect(await shownRows()).toContainEqual(['Pulse', '86 per min']);
    expect(
      within(card()).getByText('Could not display this item'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText('More vitals not shown'),
    ).toBeInTheDocument();
  });
});

describe('given "Show older vitals" (BUG-7: no server paging; legacy shows the last set however old)', () => {
  it('when it is pressed, then the window widens by 12 months and the newest set found there is shown', async () => {
    const {searches} = answer({
      vitals: {[SECOND]: vitalsForm('2025-03-04T10:15:00-05:00', 'old')},
    });
    renderCard();
    await userEvent.click(
      await within(card()).findByRole('button', {name: 'Show older vitals'}),
    );

    expect(
      await within(card()).findByText(
        'Most recent vitals from: 2025-03-04 10:15:00',
      ),
    ).toBeInTheDocument();
    expect(searches.map(url => url.searchParams.get('date'))).toEqual([
      FIRST,
      SECOND,
    ]);
  });

  it('when the wider window is empty too, then it names the new start and still offers to look further', async () => {
    answer();
    renderCard();
    await userEvent.click(
      await within(card()).findByRole('button', {name: 'Show older vitals'}),
    );

    expect(
      await within(card()).findByText(
        'No vitals have been documented since 2024-09-25.',
      ),
    ).toBeInTheDocument();
    expect(
      within(card()).getByRole('button', {name: 'Show older vitals'}),
    ).toBeEnabled();
  });

  it('when the chart switches to another patient, then their first 12 months are asked for, not the window widened before', async () => {
    const {searches} = answer();
    const {showPatient} = renderCard();
    await userEvent.click(
      await within(card()).findByRole('button', {name: 'Show older vitals'}),
    );
    await within(card()).findByText(
      'No vitals have been documented since 2024-09-25.',
    );

    showPatient(OTHER_PATIENT_ID);

    expect(
      await within(card()).findByText(
        'No vitals have been documented since 2025-09-25.',
      ),
    ).toBeInTheDocument();
    expect(
      searches
        .filter(url => url.searchParams.get('patient') === OTHER_PATIENT_ID)
        .map(url => url.searchParams.get('date')),
    ).toEqual([FIRST]);
  });
});

describe('given a reading withdrawn in OpenEMR (FR-CARD-VIT-1)', () => {
  it.each(['entered-in-error', 'cancelled'])(
    'when every reading of the newest form is %s, then that form is not the newest set and the form before it is shown',
    async status => {
      answer({
        vitals: {
          [FIRST]: [
            ...vitalsForm(JUNE_1, 'old', {...DEMO_VITALS, bps: 142, bpd: 88}),
            ...withStatus(vitalsForm(SEPT_10, 'new'), status),
          ],
        },
      });
      renderCard();

      expect(
        await within(card()).findByText(
          'Most recent vitals from: 2026-06-01 09:00:00',
        ),
      ).toBeInTheDocument();
      expect(await shownRows()).toContainEqual(['Blood Pressure', '142/88']);
      expect(within(card()).queryByText('134/84')).not.toBeInTheDocument();
    },
  );

  it('when one reading of the newest form is entered in error, then that row is left out and the form’s other readings still show', async () => {
    answer({
      vitals: {
        [FIRST]: withStatus(
          vitalsForm(SEPT_10, 'a'),
          'entered-in-error',
          'a-8867-4',
        ),
      },
    });
    renderCard();

    expect(await shownRows()).toEqual(
      DEMO_ROWS.filter(([label]) => label !== 'Pulse'),
    );
  });
});

describe('given two vitals forms stamped at the same second (legacy shows one form)', () => {
  it('when both are filed under one encounter, then every row comes from one form — the one its panel lists — never a mix of the two', async () => {
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm(SEPT_10, 'b', {pulse: 61, respiration: 20}),
          ...vitalsForm(SEPT_10, 'a'),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual(DEMO_ROWS);
    expect(
      within(card()).getAllByText(/^Most recent vitals from:/),
    ).toHaveLength(1);
  });

  it('when they are filed under different encounters, then every row comes from one form, never a mix of the two', async () => {
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm(
            SEPT_10,
            'b',
            {pulse: 61, weight: 150},
            OTHER_ENCOUNTER_ID,
          ),
          ...vitalsForm(SEPT_10, 'a'),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual(DEMO_ROWS);
  });

  it('when both hold as many readings, then one form is still shown whole, not a reading from each', async () => {
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm(SEPT_10, 'a', {pulse: 61, temperature: 98.2}),
          ...vitalsForm(SEPT_10, 'b', {respiration: 12, weight: 150}),
        ],
      },
    });
    renderCard();

    expect([
      [
        ['Temperature', '98.2 F (36.78 C)'],
        ['Pulse', '61 per min'],
      ],
      [
        ['Weight', '150 lb (68.04 kg)'],
        ['Respiration', '12 per min'],
      ],
    ]).toContainEqual(await shownRows());
  });

  it('when a reading neither form’s panel lists has a value, then it is a "Could not display this item" line, never guessed into a form (FR-CARD-3)', async () => {
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm(SEPT_10, 'a'),
          ...vitalsForm(SEPT_10, 'b', {pulse: 61, respiration: 20}),
          // The pediatric percentiles are not panel members, so only the encounter could place this one.
          vitalValue('77606-2', quantity(40, '%'), {
            id: 'unlisted-77606-2',
            effectiveDateTime: SEPT_10,
            encounter: {reference: `Encounter/${TEST_ENCOUNTER_ID}`},
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual(DEMO_ROWS);
    expect(
      within(card()).getByText('Could not display this item'),
    ).toBeInTheDocument();
  });

  it('when the forms are under different encounters, then a reading no panel lists joins the form of its own encounter', async () => {
    answer({
      vitals: {
        [FIRST]: [
          ...vitalsForm(SEPT_10, 'b', {pulse: 61}, OTHER_ENCOUNTER_ID),
          ...vitalsForm(SEPT_10, 'a'),
          vitalValue('77606-2', quantity(40, '%'), {
            id: 'unlisted-77606-2',
            effectiveDateTime: SEPT_10,
            encounter: {reference: `Encounter/${TEST_ENCOUNTER_ID}`},
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([
      ...DEMO_ROWS,
      ['Pediatric Height Weight Percentile', '40 %'],
    ]);
    expect(
      within(card()).queryByText('Could not display this item'),
    ).not.toBeInTheDocument();
  });
});
