import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {blockingAxeViolations} from '../../../test/axe';
import {
  CANARY,
  TEST_PATIENT_ID,
  careTeam,
  operationOutcome,
  organization,
  practitioner,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme, type ThemeMode} from '../../../theme/theme';
import {CareTeamCard} from './CareTeamCard';

// reference: REQUIREMENTS.md FR-CARD-CT-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5, NFR-PERF-3 ·
// INTERFACES.md API-17, API-18, API-19 · REQUIREMENTS.md SCR-DASH-CT · REQUIREMENTS.md BUG-10, BUG-52 ·
// REQUIREMENTS.md W-5

/** The legacy table's columns, in its order (manage_care_team.html.twig). */
const LEGACY_COLUMNS = [
  'Type',
  'Member',
  'Role',
  'Facility',
  'Since',
  'Status',
  'Note',
];

/** What a Status or Note cell reads as: OpenEMR's FHIR sends neither per member (BUG-52). */
const NOT_SENT = '—Not sent by OpenEMR';
const NOT_RECORDED = (what: string) => `—${what} not recorded`;

const role = (display: string) => [
  {coding: [{system: 'http://snomed.info/sct', code: '000000', display}]},
];

/** A provider participant as OpenEMR sends one: Practitioner member, SNOMED role, onBehalfOf the facility. */
function providerMember(overrides: Record<string, unknown> = {}) {
  return {
    role: role('Test cardiology role'),
    member: {
      reference: 'Practitioner/test-practitioner-0001',
      type: 'Practitioner',
    },
    onBehalfOf: {reference: 'Organization/test-org-0001'},
    period: {start: '2025-05-06'},
    ...overrides,
  };
}

/** The facility participant OpenEMR adds for each distinct member facility (FhirCareTeamService). */
const facilityParticipant = {
  role: role('Test facility role'),
  member: {reference: 'Organization/test-org-0001', type: 'Organization'},
};

interface Answers {
  readonly careTeams?: () => Response;
  readonly practitioner?: () => Response;
  readonly organization?: () => Response;
}

interface Requests {
  careTeam: URL[];
  practitioner: string[];
  organization: string[];
}

function answer(answers: Answers): Requests {
  const requests: Requests = {careTeam: [], practitioner: [], organization: []};
  server.use(
    http.get('/bff/fhir/CareTeam', ({request}) => {
      requests.careTeam.push(new URL(request.url));
      return (
        answers.careTeams?.() ?? HttpResponse.json(searchBundle([careTeam()]))
      );
    }),
    http.get('/bff/fhir/Practitioner/:id', ({params}) => {
      requests.practitioner.push(String(params.id));
      return answers.practitioner?.() ?? HttpResponse.json(practitioner());
    }),
    http.get('/bff/fhir/Organization/:id', ({params}) => {
      requests.organization.push(String(params.id));
      return answers.organization?.() ?? HttpResponse.json(organization());
    }),
  );
  return requests;
}

const teams =
  (...resources: unknown[]) =>
  () =>
    HttpResponse.json(searchBundle(resources));

function newClient(): QueryClient {
  return createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0});
}

function renderCard(
  options: {client?: QueryClient; mode?: ThemeMode} = {},
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={options.client ?? newClient()}>
      <ThemeProvider theme={createAppTheme(options.mode ?? 'light')}>
        <CareTeamCard patientId={TEST_PATIENT_ID} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const card = () => screen.getByRole('region', {name: 'Care Team'});

/** The member rows' cells, as text, once every name has settled. */
async function memberRows(
  scope: HTMLElement = card(),
): Promise<(string | null)[][]> {
  const tables = await within(scope).findAllByRole('table');
  await waitFor(() => {
    expect(within(scope).queryAllByText(/^Loading .* name…$/)).toHaveLength(0);
  });
  return tables.flatMap(table =>
    within(table)
      .getAllByRole('row')
      .slice(1)
      .map(row =>
        within(row)
          .getAllByRole('cell')
          .map(cell => cell.textContent),
      ),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('given a care team with a provider (FR-CARD-CT-1, SCR-DASH-CT)', () => {
  it('when the card loads, then the table has the legacy columns in the legacy order (guards a column dropped or reordered)', async () => {
    answer({});
    renderCard();

    const table = await within(card()).findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(LEGACY_COLUMNS);
  });

  it('when the names resolve, then the row reads Provider · name · role · facility · since, with status and note marked as not sent (guards a blank cell read as "none")', async () => {
    answer({careTeams: teams(careTeam({participant: [providerMember()]}))});
    renderCard();

    expect(await memberRows()).toEqual([
      [
        'Provider',
        'Fakedoc Testdoctor',
        'Test cardiology role',
        'Test Clinic',
        '2025-05-06',
        NOT_SENT,
        NOT_SENT,
      ],
    ]);
  });

  it('when the team loads, then its name and status head the table, as the legacy card shows them', async () => {
    answer({
      careTeams: teams(
        careTeam({name: 'Test cardiology team', status: 'active'}),
      ),
    });
    renderCard();

    expect(
      await within(card()).findByRole('heading', {
        level: 3,
        name: 'Test cardiology team — Active',
      }),
    ).toBeInTheDocument();
  });

  it('when a member row shows, then a line says OpenEMR sends no member status or note and lists removed members, and to check OpenEMR (BUG-52)', async () => {
    answer({});
    renderCard();

    expect(
      await within(card()).findByText(
        "OpenEMR's FHIR API does not send each member's status or note, and it also lists members removed from the team. Check them in OpenEMR.",
      ),
    ).toBeInTheDocument();
  });

  it('when the since date carries an offset, then the date is shown as stored, never shifted to the tablet zone (guards a member moved to another day)', async () => {
    answer({
      careTeams: teams(
        careTeam({
          participant: [
            providerMember({period: {start: '2025-05-06T00:00:00-10:00'}}),
          ],
        }),
      ),
    });
    renderCard();

    expect((await memberRows())[0]?.[4]).toBe('2025-05-06');
  });

  it.each(['+14:00', '-12:00'])(
    'when the since date is midnight at %s, then it is the day OpenEMR stored (BUG-51)',
    async offset => {
      answer({
        careTeams: teams(
          careTeam({
            participant: [
              providerMember({
                period: {start: `2025-05-06T00:00:00${offset}`},
              }),
            ],
          }),
        ),
      });
      renderCard();

      expect((await memberRows())[0]?.[4]).toBe('2025-05-06');
    },
  );

  it('when a member has no role, facility or since date, then each cell says it is not recorded', async () => {
    answer({
      careTeams: teams(
        careTeam({
          participant: [
            {
              member: {reference: 'Practitioner/test-practitioner-0001'},
            },
          ],
        }),
      ),
    });
    renderCard();

    expect(await memberRows()).toEqual([
      [
        'Provider',
        'Fakedoc Testdoctor',
        NOT_RECORDED('Role'),
        NOT_RECORDED('Facility'),
        NOT_RECORDED('Since'),
        NOT_SENT,
        NOT_SENT,
      ],
    ]);
  });
});

describe('given the facility participant OpenEMR adds for each member facility', () => {
  it('when the card loads, then only the members are rows — the facility is shown in its member row, as legacy does (guards a phantom Organization row)', async () => {
    answer({
      careTeams: teams(
        careTeam({participant: [providerMember(), facilityParticipant]}),
      ),
    });
    renderCard();

    const rows = await memberRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe('Provider');
    expect(rows[0]?.[3]).toBe('Test Clinic');
  });
});

describe('given a related person on the team', () => {
  it('when the card loads, then the row reads Related Person with "Name unavailable" — there is no read for it — and nothing is requested for it (W-5)', async () => {
    const requests = answer({
      careTeams: teams(
        careTeam({
          participant: [
            {
              role: role('Test caregiver role'),
              member: {
                reference: 'RelatedPerson/test-related-0001',
                type: 'RelatedPerson',
              },
            },
          ],
        }),
      ),
    });
    renderCard();

    expect(await memberRows()).toEqual([
      [
        'Related Person',
        'Name unavailable',
        'Test caregiver role',
        NOT_RECORDED('Facility'),
        NOT_RECORDED('Since'),
        NOT_SENT,
        NOT_SENT,
      ],
    ]);
    expect(requests.practitioner).toEqual([]);
    expect(requests.organization).toEqual([]);
  });
});

describe('given names OpenEMR will not give (BUG-10, W-5)', () => {
  it('when the practitioner and organization reads are refused (403, no admin/users), then the member and facility say "Name unavailable" and the rest of the row still shows', async () => {
    answer({
      practitioner: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
      organization: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    expect(await memberRows()).toEqual([
      [
        'Provider',
        'Name unavailable',
        NOT_RECORDED('Role'),
        'Name unavailable',
        '2025-05-06',
        NOT_SENT,
        NOT_SENT,
      ],
    ]);
    expect(card()).not.toHaveTextContent(CANARY);
  });

  it('when the practitioner read fails on the server, then the member says "Name unavailable" rather than an error', async () => {
    answer({
      practitioner: () =>
        HttpResponse.json(operationOutcome('exception'), {status: 500}),
    });
    renderCard();

    expect((await memberRows())[0]?.[1]).toBe('Name unavailable');
  });

  it('when the practitioner has no name, then the member says "Name unavailable"', async () => {
    answer({practitioner: () => HttpResponse.json(practitioner({name: []}))});
    renderCard();

    expect((await memberRows())[0]?.[1]).toBe('Name unavailable');
  });

  it('when the member reference carries its own display, then that name is shown and no read is made', async () => {
    const requests = answer({
      careTeams: teams(
        careTeam({
          participant: [
            providerMember({
              member: {
                reference: 'Practitioner/test-practitioner-0001',
                display: 'Displayed Testname',
              },
              onBehalfOf: {
                reference: 'Organization/test-org-0001',
                display: 'Displayed Clinic',
              },
            }),
          ],
        }),
      ),
    });
    renderCard();

    const row = (await memberRows())[0];
    expect(row?.[1]).toBe('Displayed Testname');
    expect(row?.[3]).toBe('Displayed Clinic');
    expect(requests.practitioner).toEqual([]);
    expect(requests.organization).toEqual([]);
  });
});

describe('given names shared across rows and teams (NFR-PERF-3)', () => {
  it('when one practitioner and one facility appear in several rows of two teams, then each is read once', async () => {
    const requests = answer({
      careTeams: teams(
        careTeam({
          id: 'test-careteam-0001',
          name: 'Test team one',
          participant: [
            providerMember(),
            providerMember(),
            facilityParticipant,
          ],
        }),
        careTeam({
          id: 'test-careteam-0002',
          name: 'Test team two',
          participant: [providerMember()],
        }),
      ),
    });
    renderCard();

    expect(await memberRows()).toHaveLength(3);
    expect(requests.practitioner).toEqual(['test-practitioner-0001']);
    expect(requests.organization).toEqual(['test-org-0001']);
  });

  it('when the card is closed and opened again an hour later in the same session, then no name is read again (guards names refetched once the cache is collected)', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true});
    const requests = answer({});
    const client = newClient();
    const first = renderCard({client});
    expect((await memberRows())[0]?.[1]).toBe('Fakedoc Testdoctor');
    first.unmount();

    vi.advanceTimersByTime(60 * 60 * 1000);
    renderCard({client});

    expect((await memberRows())[0]?.[1]).toBe('Fakedoc Testdoctor');
    expect(requests.practitioner).toHaveLength(1);
    expect(requests.organization).toHaveLength(1);
  });
});

describe('given several teams (SCR-DASH-CT)', () => {
  it('when one was entered in error, then it is not shown, as legacy hides it', async () => {
    answer({
      careTeams: teams(
        careTeam({
          id: 'test-careteam-0001',
          name: 'Test mistaken team',
          status: 'entered-in-error',
        }),
        careTeam({id: 'test-careteam-0002', name: 'Test real team'}),
      ),
    });
    renderCard();

    expect(
      await within(card()).findByRole('heading', {
        level: 3,
        name: 'Test real team — Active',
      }),
    ).toBeInTheDocument();
    expect(card()).not.toHaveTextContent('Test mistaken team');
  });

  it('when an inactive team comes first, then the active team is listed before it, as legacy puts the active team first', async () => {
    answer({
      careTeams: teams(
        careTeam({
          id: 'test-careteam-0001',
          name: 'Test old team',
          status: 'inactive',
        }),
        careTeam({id: 'test-careteam-0002', name: 'Test current team'}),
      ),
    });
    renderCard();

    await within(card()).findAllByRole('table');
    expect(
      within(card())
        .getAllByRole('heading', {level: 3})
        .map(heading => heading.textContent),
    ).toEqual(['Test current team — Active', 'Test old team — Inactive']);
  });

  it('when a team has no name and no members, then it is headed "Care team" and says it lists no members', async () => {
    answer({
      careTeams: teams(careTeam({name: undefined, participant: undefined})),
    });
    renderCard();

    expect(
      await within(card()).findByRole('heading', {
        level: 3,
        name: 'Care team — Active',
      }),
    ).toBeInTheDocument();
    expect(within(card()).getByText('No members listed')).toBeInTheDocument();
  });
});

describe('given the card states (FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5)', () => {
  it('when the search asks OpenEMR, then it sends only the patient (API-17)', async () => {
    const requests = answer({careTeams: teams()});
    renderCard();

    await within(card()).findByText('Nothing Recorded');
    expect(requests.careTeam).toHaveLength(1);
    expect([...(requests.careTeam[0]?.searchParams ?? [])]).toEqual([
      ['patient', TEST_PATIENT_ID],
    ]);
  });

  it('when the patient has no care team, then the card says "Nothing Recorded"', async () => {
    answer({careTeams: teams()});
    renderCard();

    expect(
      await within(card()).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
    expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
  });

  it('when every team was entered in error, then the card says "Nothing Recorded"', async () => {
    answer({careTeams: teams(careTeam({status: 'entered-in-error'}))});
    renderCard();

    expect(
      await within(card()).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
  });

  it('while the care team loads, then the card says so to assistive technology', async () => {
    answer({});
    renderCard();

    expect(
      within(card()).getByText('Loading the care team…'),
    ).toBeInTheDocument();
    await within(card()).findByRole('table');
  });

  it('when the care team read is refused (403), then the card says the user is not authorised, and makes no name reads', async () => {
    const requests = answer({
      careTeams: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view the care team. Access is controlled in OpenEMR.",
    );
    expect(requests.practitioner).toEqual([]);
  });

  it('when the token handler does not allow the read (404), then the card shows an error with a retry, never an empty team', async () => {
    answer({
      careTeams: () =>
        HttpResponse.json(operationOutcome('not-found'), {status: 404}),
    });
    renderCard();

    const alert = await within(card()).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the care team.");
    expect(
      within(alert).getByRole('button', {name: 'Try again'}),
    ).toBeInTheDocument();
    expect(card()).not.toHaveTextContent('Nothing Recorded');
  });

  it('when the server fails, then the card says so with a retry, and a retry that succeeds shows the team', async () => {
    let calls = 0;
    answer({
      careTeams: () => {
        calls += 1;
        return calls <= 2
          ? HttpResponse.json(operationOutcome('exception'), {status: 500})
          : HttpResponse.json(searchBundle([careTeam()]));
      },
    });
    renderCard();

    const alert = await within(card()).findByRole('alert');
    expect(alert).toHaveTextContent(
      "Couldn't load the care team (server error).",
    );
    within(alert).getByRole('button', {name: 'Try again'}).click();

    expect(await memberRows()).toHaveLength(1);
  });

  it('when the session is over (401), then the card shows nothing — the app handles sign-in', async () => {
    answer({
      careTeams: () =>
        HttpResponse.json(operationOutcome('login'), {status: 401}),
    });
    renderCard();

    await waitFor(() => {
      expect(within(card()).queryByText('Loading the care team…')).toBeNull();
    });
    expect(within(card()).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card()).queryByRole('table')).not.toBeInTheDocument();
  });

  it('when one team does not parse, then it shows "Could not display this item" in its place and the other team still shows', async () => {
    answer({
      careTeams: teams(
        {resourceType: 'CareTeam', id: 'test-careteam-bad', status: CANARY},
        careTeam({id: 'test-careteam-0002', name: 'Test good team'}),
      ),
    });
    renderCard();

    expect(
      await within(card()).findByText('Could not display this item'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByRole('heading', {
        level: 3,
        name: 'Test good team — Active',
      }),
    ).toBeInTheDocument();
    expect(card()).not.toHaveTextContent(CANARY);
  });

  it('when the search says it holds more teams than it sent, then it says "More care teams not shown", not "Could not display this item"', async () => {
    answer({
      careTeams: () =>
        HttpResponse.json({
          ...searchBundle([careTeam({name: 'Test shown team'})]),
          total: 4,
        }),
    });
    renderCard();

    expect(
      await within(card()).findByText('More care teams not shown'),
    ).toBeInTheDocument();
    expect(
      within(card()).getByRole('heading', {
        level: 3,
        name: 'Test shown team — Active',
      }),
    ).toBeInTheDocument();
    expect(
      within(card()).queryByText('Could not display this item'),
    ).toBeNull();
  });

  it('when no team came back but the search says some exist, then it says more are not shown, never "Nothing Recorded"', async () => {
    answer({
      careTeams: () => HttpResponse.json({...searchBundle([]), total: 2}),
    });
    renderCard();

    expect(
      await within(card()).findByText('More care teams not shown'),
    ).toBeInTheDocument();
    expect(within(card()).queryByText('Nothing Recorded')).toBeNull();
    expect(
      within(card()).queryByText('Could not display this item'),
    ).toBeNull();
  });
});

describe.each(['light', 'dark'] as const)(
  'given the %s theme (NFR-A11Y-1)',
  mode => {
    it('when axe scans the loaded card, then it finds no serious or critical violations', async () => {
      answer({});
      const {container} = renderCard({mode});
      await memberRows();

      expect(await blockingAxeViolations(container)).toEqual([]);
    });
  },
);
