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
  encounter,
  operationOutcome,
  organization,
  practitioner,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme} from '../../../theme/theme';
import {EncounterHistoryCard} from './EncounterHistoryCard';

// reference: REQUIREMENTS.md FR-CARD-ENC-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5, NFR-PERF-3 ·
// INTERFACES.md API-18, API-19, API-20 · REQUIREMENTS.md SCR-ENC-HIST · REQUIREMENTS.md BUG-7, BUG-9,
// BUG-10, BUG-50 · REQUIREMENTS.md W-3, W-5

/** 2026-09-25, mid-afternoon local time: "today" for the date window. */
const NOW = () => new Date(2026, 8, 25, 15, 0);

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * An encounter start as OpenEMR sends it (`getLocalDateAsUTC`): the wall-clock `fe.date` it stored, stamped with
 * the server's current offset — not converted. Legacy shows that wall-clock date.
 */
const startAt = (
  year: number,
  monthIndex: number,
  day: number,
  hour = 9,
  minute = 0,
  offset = '-05:00',
) =>
  `${String(year)}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${offset}`;

const OTHER_PATIENT_ID = 'test-patient-0002';

interface Answers {
  /** Encounters by the `date` bound the card sends (`ge2024-09-25` …); a bound not listed answers an empty Bundle. */
  readonly encounters?: Readonly<Record<string, readonly unknown[]>>;
  readonly encounterResponse?: () => Response | Promise<Response>;
  readonly practitioner?: () => Response | Promise<Response>;
  readonly organization?: () => Response | Promise<Response>;
}

function answer(answers: Answers = {}) {
  const encounterSearches: URL[] = [];
  const encounterReads: string[] = [];
  const practitionerReads: string[] = [];
  const organizationReads: string[] = [];
  server.use(
    http.get('/bff/fhir/Encounter', ({request}) => {
      const url = new URL(request.url);
      encounterSearches.push(url);
      if (answers.encounterResponse) return answers.encounterResponse();
      const bound = url.searchParams.get('date') ?? '';
      return HttpResponse.json(searchBundle(answers.encounters?.[bound] ?? []));
    }),
    http.get('/bff/fhir/Encounter/:id', ({params}) => {
      encounterReads.push(String(params.id));
      return HttpResponse.json(operationOutcome('forbidden'), {status: 403});
    }),
    http.get('/bff/fhir/Practitioner/:id', ({params}) => {
      practitionerReads.push(String(params.id));
      if (answers.practitioner) return answers.practitioner();
      return HttpResponse.json(practitioner({id: String(params.id)}));
    }),
    http.get('/bff/fhir/Organization/:id', ({params}) => {
      organizationReads.push(String(params.id));
      if (answers.organization) return answers.organization();
      return HttpResponse.json(organization({id: String(params.id)}));
    }),
  );
  return {
    encounterSearches,
    encounterReads,
    practitionerReads,
    organizationReads,
  };
}

function renderCard(patientId = TEST_PATIENT_ID) {
  const onSessionOver = vi.fn();
  const client = createQueryClient({onSessionOver, retryDelayMs: 0});
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={client}>
      <ThemeProvider theme={createAppTheme('light')}>{ui}</ThemeProvider>
    </QueryClientProvider>
  );
  const view = render(
    wrap(<EncounterHistoryCard patientId={patientId} clock={NOW} />),
  );
  return {
    onSessionOver,
    /** Re-renders the card for `id`, as the dashboard does on a patient switch or any re-render. */
    showPatient: (id: string, clock: () => Date = NOW) => {
      view.rerender(
        wrap(<EncounterHistoryCard patientId={id} clock={clock} />),
      );
    },
  };
}

const card = () => screen.getByRole('region', {name: 'Encounter History'});

/** The table's body rows as their cells' text, top to bottom. */
async function shownRows(): Promise<string[][]> {
  const table = await within(card()).findByRole('table');
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map(row =>
    within(row)
      .getAllByRole('cell')
      .map(cell => cell.textContent),
  );
}

describe('given the Encounter History read (API-20)', () => {
  it('when the card loads, then it searches this patient’s encounters from 24 months ago, and sends no paging or sort (BUG-7)', async () => {
    const {encounterSearches} = answer({
      encounters: {'ge2024-09-25': [encounter()]},
    });
    renderCard();
    await within(card()).findByText('Test reason');

    expect(encounterSearches).toHaveLength(1);
    const params = encounterSearches[0]?.searchParams;
    expect(params?.get('patient')).toBe(TEST_PATIENT_ID);
    expect(params?.getAll('date')).toEqual(['ge2024-09-25']);
    expect([...(params?.keys() ?? [])].sort()).toEqual(['date', 'patient']);
  });

  it('when the card loads and resolves names, then it never reads an encounter by id (BUG-9: admin/super only)', async () => {
    const {encounterReads} = answer({
      encounters: {
        'ge2024-09-25': [encounter(), encounter({id: 'test-encounter-0002'})],
      },
    });
    renderCard();
    await within(card()).findAllByText('Test Clinic');

    expect(encounterReads).toEqual([]);
  });
});

describe('given encounters in the window (FR-CARD-ENC-1, SCR-ENC-HIST)', () => {
  it('when the card loads, then it is a table of Date · Type · Reason · Provider · Facility (wireframe W-3)', async () => {
    answer({encounters: {'ge2024-09-25': [encounter()]}});
    renderCard();

    const table = await within(card()).findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Date', 'Type', 'Reason', 'Provider', 'Facility']);
  });

  it('when the server sends them oldest first, then they are shown newest first, as legacy orders them (fe.date DESC)', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            id: 'e-old',
            period: {start: startAt(2025, 0, 10)},
            reasonCode: [{text: 'Oldest'}],
          }),
          encounter({
            id: 'e-new',
            period: {start: startAt(2026, 8, 1)},
            reasonCode: [{text: 'Newest'}],
          }),
          encounter({
            id: 'e-mid',
            period: {start: startAt(2026, 1, 14)},
            reasonCode: [{text: 'Middle'}],
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Newest');
    const reasons = (await shownRows()).map(cells => cells[2]);
    expect(reasons).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('when two encounters start on the same day, then the later one comes first', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            id: 'e-am',
            period: {start: startAt(2026, 5, 2, 8)},
            reasonCode: [{text: 'Morning'}],
          }),
          encounter({
            id: 'e-pm',
            period: {start: startAt(2026, 5, 2, 16)},
            reasonCode: [{text: 'Afternoon'}],
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Morning');
    expect((await shownRows()).map(cells => cells[2])).toEqual([
      'Afternoon',
      'Morning',
    ]);
  });

  it('when starts carry +14:00 and -12:00, then they are ordered by the wall-clock time OpenEMR recorded, not by instant (BUG-51)', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            id: 'e-west',
            period: {start: '2026-06-02T08:00:00-12:00'},
            reasonCode: [{text: 'Eight'}],
          }),
          encounter({
            id: 'e-east',
            period: {start: '2026-06-02T09:00:00+14:00'},
            reasonCode: [{text: 'Nine'}],
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Eight');
    expect((await shownRows()).map(cells => cells[2])).toEqual([
      'Nine',
      'Eight',
    ]);
  });

  it('when two encounters start at the same moment, then the higher id comes first, as legacy breaks the tie (fe.id DESC) (review of !124)', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            id: 'e-0001',
            period: {start: startAt(2026, 5, 2, 0)},
            reasonCode: [{text: 'Recorded first'}],
          }),
          encounter({
            id: 'e-0002',
            period: {start: startAt(2026, 5, 2, 0)},
            reasonCode: [{text: 'Recorded second'}],
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Recorded first');
    expect((await shownRows()).map(cells => cells[2])).toEqual([
      'Recorded second',
      'Recorded first',
    ]);
  });

  it('when an encounter loads, then its row reads its local visit date, class, reason, provider as legacy writes it ("Last, First") and facility', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({period: {start: startAt(2026, 2, 4, 23, 30)}}),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Test Clinic');
    expect(await shownRows()).toEqual([
      [
        '2026-03-04',
        'ambulatory',
        'Test reason',
        'Testdoctor, Fakedoc',
        'Test Clinic',
      ],
    ]);
  });

  it.each(['+14:00', '-12:00'])(
    'when a visit was stored at midnight and OpenEMR stamps it with offset %s, then the row shows the stored date, never the day before or after (review of !124)',
    async offset => {
      answer({
        encounters: {
          'ge2024-09-25': [
            encounter({period: {start: `2026-01-10T00:00:00${offset}`}}),
          ],
        },
      });
      renderCard();

      await within(card()).findByText('Test reason');
      const [row] = await shownRows();
      expect(row?.[0]).toBe('2026-01-10');
    },
  );

  it.each(['2026-01', '2026-02-31T00:00:00-05:00'])(
    'when a visit start is not a whole calendar date (%s), then its row reads "Could not display this item", kept, not dropped (review of !124)',
    async start => {
      answer({
        encounters: {
          'ge2024-09-25': [
            encounter({id: 'e-good', reasonCode: [{text: 'Good one'}]}),
            encounter({id: 'e-odd', period: {start}}),
          ],
        },
      });
      renderCard();

      await within(card()).findByText('Good one');
      const rows = await shownRows();
      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual(['⚠ Could not display this item']);
    },
  );

  it('when OpenEMR sends its constant "Encounter for check up" type, then the Type column shows the encounter class instead (BUG-50)', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            class: {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
              code: 'VR',
              display: 'virtual',
            },
            type: [
              {
                coding: [
                  {
                    system: 'http://snomed.info/sct',
                    code: '185349003',
                    display: 'Encounter for check up (procedure)',
                  },
                ],
              },
            ],
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('virtual');
    expect(card()).not.toHaveTextContent('Encounter for check up');
  });

  it('when the class display is only whitespace, then the Type column shows the class code (review of !124)', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            class: {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
              code: 'AMB',
              display: '   ',
            },
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Test reason');
    const [row] = await shownRows();
    expect(row?.[1]).toBe('AMB');
  });

  it('when OpenEMR sends a class it has no code for (a CodeableConcept in the Coding slot), then the row is shown with its type not recorded (BUG-50)', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            class: {
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

    await within(card()).findByText('Test reason');
    const [row] = await shownRows();
    expect(row?.[1]).toBe('—Type not recorded');
  });

  it('when an encounter has a primary performer and a referrer, then Provider is the primary performer (legacy fe.provider_id)', async () => {
    const {practitionerReads} = answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            participant: [
              {
                type: [
                  {
                    coding: [
                      {
                        system:
                          'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
                        code: 'REF',
                      },
                    ],
                  },
                ],
                individual: {reference: 'Practitioner/test-referrer-0001'},
              },
              {
                type: [
                  {
                    coding: [
                      {
                        system:
                          'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
                        code: 'PPRF',
                      },
                    ],
                  },
                ],
                individual: {reference: 'Practitioner/test-performer-0001'},
              },
            ],
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Testdoctor, Fakedoc');
    expect(practitionerReads).toEqual(['test-performer-0001']);
  });

  it('when an encounter has no reason, provider or facility, then Provider reads "Unknown" as legacy prints it, the others "not recorded", and nothing is looked up (review of !124)', async () => {
    const {practitionerReads, organizationReads} = answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            reasonCode: undefined,
            participant: undefined,
            serviceProvider: undefined,
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByRole('table');
    const [row] = await shownRows();
    expect(row?.slice(2)).toEqual([
      '—Reason not recorded',
      'Unknown',
      '—Facility not recorded',
    ]);
    expect(practitionerReads).toEqual([]);
    expect(organizationReads).toEqual([]);
  });
});

describe('given provider and facility names (API-18, API-19, NFR-PERF-3)', () => {
  it('when many encounters share a provider and a facility, then each name is read once', async () => {
    const {practitionerReads, organizationReads} = answer({
      encounters: {
        'ge2024-09-25': [
          encounter({id: 'e1'}),
          encounter({id: 'e2', period: {start: startAt(2026, 0, 2)}}),
          encounter({id: 'e3', period: {start: startAt(2025, 5, 6)}}),
        ],
      },
    });
    renderCard();

    expect(await within(card()).findAllByText('Test Clinic')).toHaveLength(3);
    expect(practitionerReads).toEqual(['test-practitioner-0001']);
    expect(organizationReads).toEqual(['test-org-0001']);
  });

  it('when the names are slow, then the encounters are shown at once and each name says it is loading (never block the list)', async () => {
    answer({
      encounters: {'ge2024-09-25': [encounter()]},
      practitioner: async () => {
        await delay('infinite');
        return HttpResponse.json(practitioner());
      },
      organization: async () => {
        await delay('infinite');
        return HttpResponse.json(organization());
      },
    });
    renderCard();

    expect(await within(card()).findByText('Test reason')).toBeInTheDocument();
    expect(
      within(card()).getByText('Loading provider name…'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText('Loading facility name…'),
    ).toBeInTheDocument();
  });

  it('when the provider and facility reads are refused (BUG-10, 403), then both read "Name unavailable" (W-5) and the encounter still shows', async () => {
    answer({
      encounters: {'ge2024-09-25': [encounter()]},
      practitioner: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
      organization: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    await waitFor(() => {
      expect(within(card()).getAllByText('Name unavailable')).toHaveLength(2);
    });
    expect(within(card()).getByText('Test reason')).toBeInTheDocument();
    expect(within(card()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('when a name read fails on the server or returns something malformed, then it reads "Name unavailable"', async () => {
    answer({
      encounters: {'ge2024-09-25': [encounter()]},
      practitioner: () => HttpResponse.json({resourceType: 'Practitioner'}),
      organization: () =>
        HttpResponse.json(operationOutcome('exception'), {status: 500}),
    });
    renderCard();

    await waitFor(() => {
      expect(within(card()).getAllByText('Name unavailable')).toHaveLength(2);
    });
  });

  it('when a reference is not a plain Practitioner or Organization id, then it reads "Name unavailable" and is not fetched', async () => {
    const {practitionerReads, organizationReads} = answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            participant: [
              {
                individual: {
                  reference: 'https://elsewhere.test/Practitioner/1',
                },
              },
            ],
            serviceProvider: {reference: 'Location/test-location-0001'},
          }),
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Test reason');
    expect(within(card()).getAllByText('Name unavailable')).toHaveLength(2);
    expect(practitionerReads).toEqual([]);
    expect(organizationReads).toEqual([]);
  });

  it('when a reference carries its own display name, then that name is shown and not fetched', async () => {
    const {practitionerReads, organizationReads} = answer({
      encounters: {
        'ge2024-09-25': [
          encounter({
            participant: [
              {
                individual: {
                  reference: 'Practitioner/test-practitioner-0001',
                  display: 'Displayed Doctor',
                },
              },
            ],
            serviceProvider: {
              reference: 'Organization/test-org-0001',
              display: 'Displayed Clinic',
            },
          }),
        ],
      },
    });
    renderCard();

    expect(
      await within(card()).findByText('Displayed Doctor'),
    ).toBeInTheDocument();
    expect(within(card()).getByText('Displayed Clinic')).toBeInTheDocument();
    expect(practitionerReads).toEqual([]);
    expect(organizationReads).toEqual([]);
  });
});

describe('given the card’s states (FR-CARD-1, FR-CARD-4, FR-AUTH-5)', () => {
  it('when the read is in flight, then the card is busy and says it is loading encounters', async () => {
    answer({
      encounterResponse: async () => {
        await delay('infinite');
        return HttpResponse.json(searchBundle([]));
      },
    });
    renderCard();

    expect(
      await within(card()).findByText('Loading encounters…'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText('Loading encounters…').closest('[aria-busy]'),
    ).toHaveAttribute('aria-busy', 'true');
  });

  it('when there are no encounters in the window, then it shows the legacy "Nothing Recorded", names the window, and still offers older ones (BUG-7)', async () => {
    answer();
    renderCard();

    expect(
      await within(card()).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
    expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
    expect(
      within(card()).getByText('Showing encounters since 2024-09-25.'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByRole('button', {name: 'Show older encounters'}),
    ).toBeInTheDocument();
  });

  it('when the read is refused (403), then it says the user is not authorised, with no retry', async () => {
    answer({
      encounterResponse: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view encounters. Access is controlled in OpenEMR.",
    );
    expect(
      within(card()).queryByRole('button', {name: 'Try again'}),
    ).not.toBeInTheDocument();
    expect(
      within(card()).queryByRole('button', {name: 'Show older encounters'}),
    ).not.toBeInTheDocument();
  });

  it('when the read fails on the server, then it says so with "Try again", which reloads the encounters', async () => {
    let fail = true;
    answer({
      encounterResponse: () =>
        fail
          ? HttpResponse.json(operationOutcome('exception'), {status: 500})
          : HttpResponse.json(searchBundle([encounter()])),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load encounters (server error).",
    );
    fail = false;
    await userEvent.click(
      within(card()).getByRole('button', {name: 'Try again'}),
    );
    expect(await within(card()).findByText('Test reason')).toBeInTheDocument();
  });

  it('when the session is over (401), then the card shows nothing of the patient and the app is told', async () => {
    answer({
      encounterResponse: () =>
        HttpResponse.json(operationOutcome('login'), {status: 401}),
    });
    const {onSessionOver} = renderCard();

    await waitFor(() => {
      expect(onSessionOver).toHaveBeenCalledOnce();
    });
    expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
    expect(within(card()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('when one encounter is malformed, then it is a "Could not display this item" row and the others still show (FR-CARD-3)', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [
          encounter({id: 'e-good', reasonCode: [{text: 'Good one'}]}),
          {resourceType: 'Encounter', id: 'e-bad', status: 'not-a-status'},
        ],
      },
    });
    renderCard();

    await within(card()).findByText('Good one');
    const rows = await shownRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['⚠ Could not display this item']);
  });

  it('when the search says it holds more encounters than it sent, then the last row says "More encounters not shown", not "Could not display this item"', async () => {
    answer({
      encounterResponse: () =>
        HttpResponse.json({
          ...searchBundle([
            encounter({
              id: 'e-good',
              reasonCode: [{text: 'Good one'}],
            }),
          ]),
          total: 3,
        }),
    });
    renderCard();

    await within(card()).findByText('Good one');
    const rows = await shownRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['⚠ More encounters not shown']);
    expect(
      within(card()).queryByText('Could not display this item'),
    ).toBeNull();
  });

  it('when no encounter came back but the search says some exist, then it says more are not shown, never "Nothing Recorded"', async () => {
    answer({
      encounterResponse: () =>
        HttpResponse.json({...searchBundle([]), total: 2}),
    });
    renderCard();

    expect(
      await within(card()).findByText('More encounters not shown'),
    ).toBeInTheDocument();
    expect(within(card()).queryByText('Nothing Recorded')).toBeNull();
    expect(
      within(card()).queryByText('Could not display this item'),
    ).toBeNull();
  });
});

describe('given "Show older encounters" (BUG-7: no server paging)', () => {
  it('when it is pressed, then the window widens by 24 months, the shown encounters stay while it loads, and the older ones join them newest first', async () => {
    let releaseOlder: () => void = () => undefined;
    const older = new Promise<void>(resolve => {
      releaseOlder = resolve;
    });
    const recent = encounter({
      id: 'e-recent',
      period: {start: startAt(2026, 1, 1)},
      reasonCode: [{text: 'Recent visit'}],
    });
    const {encounterSearches} = answer({
      encounters: {
        'ge2024-09-25': [recent],
        'ge2022-09-25': [
          recent,
          encounter({
            id: 'e-older',
            period: {start: startAt(2023, 3, 5)},
            reasonCode: [{text: 'Older visit'}],
          }),
        ],
      },
    });
    server.use(
      http.get('/bff/fhir/Encounter', async ({request}) => {
        const url = new URL(request.url);
        if (url.searchParams.get('date') !== 'ge2022-09-25') return undefined;
        encounterSearches.push(url);
        await older;
        return undefined;
      }),
    );
    renderCard();
    await within(card()).findByText('Recent visit');

    await userEvent.click(
      within(card()).getByRole('button', {name: 'Show older encounters'}),
    );

    const loading = await within(card()).findByRole('button', {
      name: 'Loading older encounters…',
    });
    expect(loading).toBeDisabled();
    expect(within(card()).getByText('Recent visit')).toBeInTheDocument();
    expect(within(card()).getByRole('table')).toHaveAttribute(
      'aria-busy',
      'true',
    );

    releaseOlder();
    expect(await within(card()).findByText('Older visit')).toBeInTheDocument();
    expect((await shownRows()).map(cells => cells[2])).toEqual([
      'Recent visit',
      'Older visit',
    ]);
    expect(
      within(card()).getByText('Showing encounters since 2022-09-25.'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByRole('button', {name: 'Show older encounters'}),
    ).toBeEnabled();
    expect(
      encounterSearches.map(url => url.searchParams.get('date')),
    ).toContain('ge2022-09-25');
  });

  it('when the card re-renders after local midnight, then the window stays where it was and nothing reloads (review of !124)', async () => {
    const {encounterSearches} = answer({
      encounters: {'ge2024-09-25': [encounter()]},
    });
    const {showPatient} = renderCard();
    await within(card()).findByText('Test reason');

    showPatient(TEST_PATIENT_ID, () => new Date(2026, 8, 26, 0, 5));

    expect(
      within(card()).getByText('Showing encounters since 2024-09-25.'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByRole('button', {name: 'Show older encounters'}),
    ).toBeEnabled();
    expect(within(card()).getByRole('table')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    expect(encounterSearches).toHaveLength(1);
  });

  it('when the chart switches to another patient, then their first 24 months are asked for and the previous patient’s encounters are never shown, not even for one render (review of !124)', async () => {
    const {encounterSearches} = answer({
      encounters: {
        'ge2024-09-25': [encounter({reasonCode: [{text: 'First patient'}]})],
      },
    });
    const {showPatient} = renderCard();
    await within(card()).findByText('First patient');
    await userEvent.click(
      within(card()).getByRole('button', {name: 'Show older encounters'}),
    );
    await within(card()).findByText('Showing encounters since 2022-09-25.');

    server.use(
      http.get('/bff/fhir/Encounter', async ({request}) => {
        const url = new URL(request.url);
        if (url.searchParams.get('patient') !== OTHER_PATIENT_ID) {
          return undefined;
        }
        encounterSearches.push(url);
        await delay('infinite');
        return HttpResponse.json(searchBundle([]));
      }),
    );
    showPatient(OTHER_PATIENT_ID);

    expect(within(card()).queryByText('First patient')).not.toBeInTheDocument();
    expect(within(card()).getByText('Loading encounters…')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        encounterSearches
          .filter(url => url.searchParams.get('patient') === OTHER_PATIENT_ID)
          .map(url => url.searchParams.get('date')),
      ).toEqual(['ge2024-09-25']);
    });
  });

  it('when the chart switches away and back, then the first patient starts again at 24 months, not at the window widened before (review of !124)', async () => {
    answer({
      encounters: {
        'ge2024-09-25': [encounter({reasonCode: [{text: 'First patient'}]})],
      },
    });
    const {showPatient} = renderCard();
    await within(card()).findByText('First patient');
    await userEvent.click(
      within(card()).getByRole('button', {name: 'Show older encounters'}),
    );
    await within(card()).findByText('Showing encounters since 2022-09-25.');

    showPatient(OTHER_PATIENT_ID);
    await within(card()).findByText('Showing encounters since 2024-09-25.');
    showPatient(TEST_PATIENT_ID);

    expect(
      await within(card()).findByText('Showing encounters since 2024-09-25.'),
    ).toBeInTheDocument();
  });
});
