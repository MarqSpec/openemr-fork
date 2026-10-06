import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {delay, http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {
  TEST_PATIENT_ID,
  labResult,
  operationOutcome,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme} from '../../../theme/theme';
import {LabsCard} from './LabsCard';

// reference: REQUIREMENTS.md FR-CARD-LAB-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// INTERFACES.md API-22 · REQUIREMENTS.md SCR-DASH-LAB · REQUIREMENTS.md BUG-7, BUG-36, BUG-51, BUG-56,
// BUG-57, BUG-58 · REQUIREMENTS.md W-3, W-5

/** 2026-09-25, mid-afternoon local time: "today" for the date window. */
const NOW = () => new Date(2026, 8, 25, 15, 0);

const OTHER_PATIENT_ID = 'test-patient-0002';

/** A LOINC code with its display, as OpenEMR codes a result (the display is `procedure_result.result_text`). */
const loinc = (code: string, display: string) => ({
  coding: [{system: 'http://loinc.org', code, display}],
});

/** OpenEMR's code for a result with no LOINC code or no text: a null flavour, the name gone (BUG-56). */
const UNNAMED = {
  coding: [
    {
      system: 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor',
      code: 'UNK',
      display: 'unknown',
    },
  ],
};

/** OpenEMR's abnormal flag (`proc_res_abnormal`), coded from the list's `codes` column. */
const flag = (code: string, display: string) => [
  {
    coding: [
      {
        system:
          'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
        code,
        display,
      },
    ],
  },
];

interface Answers {
  /** Results by the `date` bound the card sends (`ge2025-09-25` …); a bound not listed answers an empty Bundle. */
  readonly results?: Readonly<Record<string, readonly unknown[]>>;
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
      return HttpResponse.json(searchBundle(answers.results?.[bound] ?? []));
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
  const view = render(wrap(<LabsCard patientId={patientId} clock={NOW} />));
  return {
    onSessionOver,
    /** Re-renders the card for `id`, as the dashboard does on a patient switch or any re-render. */
    showPatient: (id: string, clock: () => Date = NOW) => {
      view.rerender(wrap(<LabsCard patientId={id} clock={clock} />));
    },
  };
}

const card = () => screen.getByRole('region', {name: 'Labs'});

/** The heading a partial result carries instead of claiming the latest. */
const PARTIAL_HEADING =
  'Lab data (more not shown; these may not be the latest results)';

/** The table's body rows as their cells' text, top to bottom: Test · Result · Date. */
async function shownRows(name = 'Most recent lab data'): Promise<string[][]> {
  const table = await within(card()).findByRole('table', {name});
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map(row =>
    [
      ...within(row).queryAllByRole('rowheader'),
      ...within(row).getAllByRole('cell'),
    ].map(cell => cell.textContent),
  );
}

describe('given the Labs read (API-22)', () => {
  it('when the card loads, then it searches this patient’s laboratory results from 12 months ago, and sends nothing else — no code, paging or sort (BUG-7, BUG-36)', async () => {
    const {searches} = answer({results: {'ge2025-09-25': [labResult()]}});
    renderCard();
    await within(card()).findByText('Test hemoglobin A1c');

    expect(searches).toHaveLength(1);
    const params = searches[0]?.searchParams;
    expect(params?.getAll('patient')).toEqual([TEST_PATIENT_ID]);
    expect(params?.getAll('category')).toEqual(['laboratory']);
    expect(params?.getAll('date')).toEqual(['ge2025-09-25']);
    expect([...(params?.keys() ?? [])].sort()).toEqual([
      'category',
      'date',
      'patient',
    ]);
  });

  it('when the patient id is not a FHIR id, then nothing is sent and the card says it could not load lab data', async () => {
    const {searches} = answer();
    render(
      <QueryClientProvider
        client={createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0})}
      >
        <LabsCard patientId="../Patient" clock={NOW} />
      </QueryClientProvider>,
    );

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load lab data.",
    );
    expect(searches).toEqual([]);
  });
});

describe('given lab results in the window (FR-CARD-LAB-1, SCR-DASH-LAB)', () => {
  it('when the card loads, then under the legacy "Most recent lab data" it is a table of Test · Result · Date (wireframe W-3)', async () => {
    answer({results: {'ge2025-09-25': [labResult()]}});
    renderCard();

    const table = await within(card()).findByRole('table', {
      name: 'Most recent lab data',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Test', 'Result', 'Date']);
    expect(await shownRows()).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2026-08-30'],
    ]);
  });

  it('when a test was resulted more than once, then only its latest result is shown, beside its date (BUG-36: latest per code)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({
            id: 'r-old',
            effectiveDateTime: '2026-01-10T08:00:00-05:00',
            valueQuantity: {value: 8.4, unit: '%'},
          }),
          labResult({
            id: 'r-new',
            effectiveDateTime: '2026-08-30T10:15:00-04:00',
            valueQuantity: {value: 7.1, unit: '%'},
          }),
          labResult({
            id: 'r-mid',
            effectiveDateTime: '2026-04-02T09:00:00-04:00',
            valueQuantity: {value: 7.9, unit: '%'},
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2026-08-30'],
    ]);
  });

  it('when several tests are resulted, then each test’s latest is shown, newest first', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({
            id: 'r-ldl',
            code: loinc('13457-7', 'Test LDL cholesterol'),
            effectiveDateTime: '2026-03-15T09:00:00-04:00',
            valueQuantity: {value: 92, unit: 'mg/dL'},
          }),
          labResult({
            id: 'r-a1c',
            effectiveDateTime: '2026-08-30T10:15:00-04:00',
          }),
          labResult({
            id: 'r-glucose',
            code: loinc('2345-7', 'Test glucose'),
            effectiveDateTime: '2026-06-01T07:30:00-04:00',
            valueQuantity: {value: 104, unit: 'mg/dL'},
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2026-08-30'],
      ['Test glucose', '104 mg/dL', '2026-06-01'],
      ['Test LDL cholesterol', '92 mg/dL', '2026-03-15'],
    ]);
  });

  it('when report dates carry +14:00 and -12:00, then the latest is the latest wall-clock time OpenEMR recorded and each shows its recorded date, never the instant’s (BUG-51)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          // As instants the +14:00 one is the earlier; as recorded it is the later, and legacy orders by what it stored.
          labResult({
            id: 'r-west',
            effectiveDateTime: '2026-08-30T08:00:00-12:00',
            valueQuantity: {value: 6.2, unit: '%'},
          }),
          labResult({
            id: 'r-east',
            effectiveDateTime: '2026-08-30T09:00:00+14:00',
            valueQuantity: {value: 6.8, unit: '%'},
          }),
          labResult({
            id: 'r-midnight',
            code: loinc('2345-7', 'Test glucose'),
            effectiveDateTime: '2026-08-01T00:00:00+14:00',
            valueQuantity: {value: 99, unit: 'mg/dL'},
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([
      ['Test hemoglobin A1c', '6.8 %', '2026-08-30'],
      ['Test glucose', '99 mg/dL', '2026-08-01'],
    ]);
  });

  it('when a result is flagged High, Low, Abnormal or beyond a panic limit, then the flag is in words beside the value; a Normal flag adds nothing (colour never the only signal)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({
            id: 'r-high',
            code: loinc('2345-7', 'Test glucose'),
            interpretation: flag('H', 'High'),
            valueQuantity: {value: 182, unit: 'mg/dL'},
          }),
          labResult({
            id: 'r-low',
            code: loinc('2823-3', 'Test potassium'),
            interpretation: flag('L', 'Low'),
            valueQuantity: {value: 3.1, unit: 'mmol/L'},
          }),
          labResult({
            id: 'r-abnormal',
            code: loinc('5778-6', 'Test urine color'),
            interpretation: flag('A', 'Yes'),
            valueString: 'Test amber',
            valueQuantity: undefined,
          }),
          labResult({
            id: 'r-panic',
            code: loinc('2951-2', 'Test sodium'),
            interpretation: flag('LL', 'Below lower panic limits'),
            valueQuantity: {value: 118, unit: 'mmol/L'},
          }),
          labResult({
            id: 'r-normal',
            code: loinc('718-7', 'Test hemoglobin'),
            interpretation: flag('N', 'No'),
            valueQuantity: {value: 13.9, unit: 'g/dL'},
          }),
        ],
      },
    });
    renderCard();

    const results = (await shownRows()).map(([name, result]) => [name, result]);
    expect(results).toEqual([
      ['Test glucose', '182 mg/dL · High'],
      ['Test potassium', '3.1 mmol/L · Low'],
      ['Test urine color', 'Test amber · Abnormal'],
      ['Test sodium', '118 mmol/L · Below lower panic limits'],
      ['Test hemoglobin', '13.9 g/dL'],
    ]);
  });

  it('when a flag comes as text only (no code in the abnormal list), then the text is shown', async () => {
    answer({
      results: {
        'ge2025-09-25': [labResult({interpretation: [{text: 'Test flag'}]})],
      },
    });
    renderCard();

    expect((await shownRows())[0]?.[1]).toBe('7.1 % · Test flag');
  });

  it('when a result is text or a coded answer, then it is shown as sent, with no unit (BUG-56: a text result loses its unit)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({
            id: 'r-text',
            code: loinc('5196-1', 'Test hepatitis B surface antigen'),
            valueQuantity: undefined,
            valueString: '<5',
          }),
          labResult({
            id: 'r-coded',
            code: loinc('5778-6', 'Test urine color'),
            valueQuantity: undefined,
            valueCodeableConcept: {
              coding: [
                {
                  system: 'http://snomed.info/sct',
                  code: '371244009',
                  display: 'Test yellow',
                },
              ],
            },
          }),
        ],
      },
    });
    renderCard();

    expect((await shownRows()).map(([, result]) => result)).toEqual([
      '<5',
      'Test yellow',
    ]);
  });

  it('when a result has no value (OpenEMR sends a result of 0 that way too), then it says no value was sent and to check OpenEMR, never a blank (BUG-56)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({
            valueQuantity: undefined,
            dataAbsentReason: {
              coding: [
                {
                  system:
                    'http://terminology.hl7.org/CodeSystem/data-absent-reason',
                  code: 'unknown',
                  display: 'Unknown',
                },
              ],
            },
          }),
        ],
      },
    });
    renderCard();

    expect((await shownRows())[0]).toEqual([
      'Test hemoglobin A1c',
      'No value sent; check OpenEMR',
      '2026-08-30',
    ]);
  });

  it('when OpenEMR sends a result with no name (a null-flavour code), then it says so, and two such results are not merged into one test (BUG-56)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({id: 'r-unnamed-1', code: UNNAMED}),
          labResult({
            id: 'r-unnamed-2',
            code: UNNAMED,
            valueQuantity: {value: 4.2, unit: 'mmol/L'},
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([
      ['Name not sent by OpenEMR', '7.1 %', '2026-08-30'],
      ['Name not sent by OpenEMR', '4.2 mmol/L', '2026-08-30'],
    ]);
  });

  it('when a code has no display, then the code itself names the test rather than nothing', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({
            code: {coding: [{system: 'http://loinc.org', code: '4548-4'}]},
          }),
        ],
      },
    });
    renderCard();

    expect((await shownRows())[0]?.[0]).toBe('4548-4');
  });

  it('when a result is not final, then its status is in words — OpenEMR sends every status but final as "unknown", so that reads "Status unknown" (BUG-57)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({
            id: 'r-unknown',
            code: loinc('2345-7', 'Test glucose'),
            status: 'unknown',
            valueQuantity: {value: 104, unit: 'mg/dL'},
          }),
          labResult({
            id: 'r-prelim',
            code: loinc('2823-3', 'Test potassium'),
            status: 'preliminary',
            valueQuantity: {value: 4.1, unit: 'mmol/L'},
          }),
          labResult({
            id: 'r-error',
            code: loinc('2951-2', 'Test sodium'),
            status: 'entered-in-error',
            valueQuantity: {value: 140, unit: 'mmol/L'},
          }),
          labResult({id: 'r-final', status: 'final'}),
          labResult({
            id: 'r-corrected',
            code: loinc('718-7', 'Test hemoglobin'),
            status: 'corrected',
            valueQuantity: {value: 13.9, unit: 'g/dL'},
          }),
        ],
      },
    });
    renderCard();

    expect((await shownRows()).map(([name, result]) => [name, result])).toEqual(
      [
        ['Test glucose', '104 mg/dL · Status unknown'],
        ['Test potassium', '4.1 mmol/L · Preliminary'],
        ['Test sodium', '140 mmol/L · Entered in error'],
        ['Test hemoglobin A1c', '7.1 %'],
        ['Test hemoglobin', '13.9 g/dL · Corrected'],
      ],
    );
  });

  it('when a result has no report date, then it still shows, "Date not recorded", after the dated ones; a dated result of the same test wins (BUG-58)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          labResult({
            id: 'r-undated',
            code: loinc('2345-7', 'Test glucose'),
            effectiveDateTime: undefined,
            valueQuantity: {value: 104, unit: 'mg/dL'},
          }),
          labResult({
            id: 'r-a1c-undated',
            effectiveDateTime: undefined,
            valueQuantity: {value: 9.9, unit: '%'},
          }),
          labResult({id: 'r-a1c-dated'}),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2026-08-30'],
      ['Test glucose', '104 mg/dL', 'Date not recorded'],
    ]);
  });

  it('when one result is malformed, or its date is not a calendar date, then each is a "Could not display this item" row after the others (FR-CARD-3)', async () => {
    answer({
      results: {
        'ge2025-09-25': [
          {resourceType: 'Observation', id: 'r-bad', status: 'not-a-status'},
          labResult({id: 'r-good'}),
          labResult({
            id: 'r-bad-date',
            code: loinc('2345-7', 'Test glucose'),
            effectiveDateTime: '2026-02-30T09:00:00-05:00',
          }),
        ],
      },
    });
    renderCard();

    expect(await shownRows()).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2026-08-30'],
      ['⚠ Could not display this item'],
      ['⚠ Could not display this item'],
    ]);
  });

  it('when the Bundle says it holds more than it sent, then the last row says "More lab data not shown", never "Could not display this item"', async () => {
    answer({
      response: () =>
        HttpResponse.json({...searchBundle([labResult()]), total: 5}),
    });
    renderCard();

    expect(await shownRows(PARTIAL_HEADING)).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2026-08-30'],
      ['⚠ More lab data not shown'],
    ]);
    expect(
      within(card()).queryByText('Could not display this item'),
    ).toBeNull();
  });

  it('when the Bundle is partial, then the card does not claim the latest result of each test — neither in its heading nor under the table', async () => {
    answer({
      response: () =>
        HttpResponse.json({...searchBundle([labResult()]), total: 5}),
    });
    renderCard();
    await shownRows(PARTIAL_HEADING);

    expect(within(card()).queryByText('Most recent lab data')).toBeNull();
    expect(
      within(card()).queryByText(/Showing the latest result of each test/),
    ).toBeNull();
    expect(
      within(card()).getByText(
        'Showing results since 2025-09-25; more not shown, so a later result of a test may be missing.',
      ),
    ).toBeInTheDocument();
  });

  it('when no result came back but the Bundle says some exist, then it says more lab data is not shown, never "No lab data documented"', async () => {
    answer({
      response: () => HttpResponse.json({...searchBundle([]), total: 2}),
    });
    renderCard();

    expect(await shownRows(PARTIAL_HEADING)).toEqual([
      ['⚠ More lab data not shown'],
    ]);
    expect(within(card()).queryByText(/No lab data documented/)).toBeNull();
    expect(
      within(card()).queryByText('Could not display this item'),
    ).toBeNull();
  });

  it('when one result does not parse and the Bundle is partial, then that row stays "Could not display this item" and the partial result is worded apart, last', async () => {
    answer({
      response: () =>
        HttpResponse.json({
          ...searchBundle([
            labResult(),
            {resourceType: 'Observation', id: 'r-bad', status: 'not-a-status'},
          ]),
          total: 9,
        }),
    });
    renderCard();

    expect(await shownRows(PARTIAL_HEADING)).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2026-08-30'],
      ['⚠ Could not display this item'],
      ['⚠ More lab data not shown'],
    ]);
  });

  it('when results are shown, then the card names the window they cover and offers older ones (BUG-7)', async () => {
    answer({results: {'ge2025-09-25': [labResult()]}});
    renderCard();
    await shownRows();

    expect(
      within(card()).getByText(
        'Showing the latest result of each test since 2025-09-25.',
      ),
    ).toBeInTheDocument();
    expect(
      within(card()).getByRole('button', {name: 'Show older lab data'}),
    ).toBeInTheDocument();
  });
});

describe('given the card’s states (FR-CARD-1, FR-CARD-4, FR-AUTH-5)', () => {
  it('when the read is in flight, then the card is busy and says it is loading lab data', async () => {
    answer({
      response: async () => {
        await delay('infinite');
        return HttpResponse.json(searchBundle([]));
      },
    });
    renderCard();

    expect(
      await within(card()).findByText('Loading lab data…'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText('Loading lab data…').closest('[aria-busy]'),
    ).toHaveAttribute('aria-busy', 'true');
  });

  it('when there are no results in the window, then it shows the legacy "No lab data documented", names the window, and offers older ones', async () => {
    answer();
    renderCard();

    expect(
      await within(card()).findByText(
        'No lab data documented since 2025-09-25.',
      ),
    ).toBeInTheDocument();
    expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
    expect(
      within(card()).getByRole('button', {name: 'Show older lab data'}),
    ).toBeInTheDocument();
  });

  it('when the read is refused (403), then it says the user is not authorised, with no retry', async () => {
    answer({
      response: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view lab data. Access is controlled in OpenEMR.",
    );
    expect(
      within(card()).queryByRole('button', {name: 'Try again'}),
    ).not.toBeInTheDocument();
    expect(
      within(card()).queryByRole('button', {name: 'Show older lab data'}),
    ).not.toBeInTheDocument();
  });

  it('when the read fails on the server, then it says so with "Try again", which reloads the results', async () => {
    let fail = true;
    answer({
      response: () =>
        fail
          ? HttpResponse.json(operationOutcome('exception'), {status: 500})
          : HttpResponse.json(searchBundle([labResult()])),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load lab data (server error).",
    );
    fail = false;
    await userEvent.click(
      within(card()).getByRole('button', {name: 'Try again'}),
    );
    expect(
      await within(card()).findByText('Test hemoglobin A1c'),
    ).toBeInTheDocument();
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

  it('when the answer is not a Bundle, then the card says it could not load lab data', async () => {
    answer({response: () => HttpResponse.json(labResult())});
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load lab data.",
    );
  });
});

describe('given "Show older lab data" (BUG-7: no server paging; legacy shows the last result however old)', () => {
  it('when it is pressed on an empty year, then the window widens by 12 months, the card is busy while it loads, and older results appear', async () => {
    let releaseOlder: () => void = () => undefined;
    const older = new Promise<void>(resolve => {
      releaseOlder = resolve;
    });
    const {searches} = answer({
      results: {
        'ge2024-09-25': [
          labResult({effectiveDateTime: '2025-02-11T09:00:00-05:00'}),
        ],
      },
    });
    server.use(
      http.get('/bff/fhir/Observation', async ({request}) => {
        const url = new URL(request.url);
        if (url.searchParams.get('date') !== 'ge2024-09-25') return undefined;
        searches.push(url);
        await older;
        return undefined;
      }),
    );
    renderCard();
    await within(card()).findByText('No lab data documented since 2025-09-25.');

    await userEvent.click(
      within(card()).getByRole('button', {name: 'Show older lab data'}),
    );

    const loading = await within(card()).findByRole('button', {
      name: 'Loading older lab data…',
    });
    expect(loading).toBeDisabled();
    expect(
      within(card()).getByText('No lab data documented since 2025-09-25.'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText('No lab data documented since 2025-09-25.')
        .parentElement,
    ).toHaveAttribute('aria-busy', 'true');

    releaseOlder();
    expect(await shownRows()).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2025-02-11'],
    ]);
    expect(
      within(card()).getByText(
        'Showing the latest result of each test since 2024-09-25.',
      ),
    ).toBeInTheDocument();
    expect(searches.map(url => url.searchParams.get('date'))).toContain(
      'ge2024-09-25',
    );
  });

  it('when it is pressed with results shown, then they stay while it loads and a test seen only earlier joins them', async () => {
    const recent = labResult({id: 'r-recent'});
    answer({
      results: {
        'ge2025-09-25': [recent],
        'ge2024-09-25': [
          recent,
          labResult({
            id: 'r-older',
            code: loinc('13457-7', 'Test LDL cholesterol'),
            effectiveDateTime: '2025-03-15T09:00:00-04:00',
            valueQuantity: {value: 92, unit: 'mg/dL'},
          }),
        ],
      },
    });
    renderCard();
    await shownRows();

    await userEvent.click(
      within(card()).getByRole('button', {name: 'Show older lab data'}),
    );

    expect(
      await within(card()).findByText('Test LDL cholesterol'),
    ).toBeInTheDocument();
    expect(await shownRows()).toEqual([
      ['Test hemoglobin A1c', '7.1 %', '2026-08-30'],
      ['Test LDL cholesterol', '92 mg/dL', '2025-03-15'],
    ]);
  });

  it('when the card re-renders after local midnight, then the window stays where it was and nothing reloads', async () => {
    const {searches} = answer({results: {'ge2025-09-25': [labResult()]}});
    const {showPatient} = renderCard();
    await shownRows();

    showPatient(TEST_PATIENT_ID, () => new Date(2026, 8, 26, 0, 5));

    expect(
      within(card()).getByText(
        'Showing the latest result of each test since 2025-09-25.',
      ),
    ).toBeInTheDocument();
    expect(searches).toHaveLength(1);
  });

  it('when the chart switches to another patient, then their first 12 months are asked for and the previous patient’s results are never shown, not even for one render', async () => {
    const {searches} = answer({
      results: {
        'ge2025-09-25': [labResult()],
        'ge2024-09-25': [labResult()],
      },
    });
    const {showPatient} = renderCard();
    await shownRows();
    await userEvent.click(
      within(card()).getByRole('button', {name: 'Show older lab data'}),
    );
    await within(card()).findByText(
      'Showing the latest result of each test since 2024-09-25.',
    );

    server.use(
      http.get('/bff/fhir/Observation', async ({request}) => {
        const url = new URL(request.url);
        if (url.searchParams.get('patient') !== OTHER_PATIENT_ID) {
          return undefined;
        }
        searches.push(url);
        await delay('infinite');
        return HttpResponse.json(searchBundle([]));
      }),
    );
    showPatient(OTHER_PATIENT_ID);

    expect(
      within(card()).queryByText('Test hemoglobin A1c'),
    ).not.toBeInTheDocument();
    expect(within(card()).getByText('Loading lab data…')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        searches
          .filter(url => url.searchParams.get('patient') === OTHER_PATIENT_ID)
          .map(url => url.searchParams.get('date')),
      ).toEqual(['ge2025-09-25']);
    });
  });
});
