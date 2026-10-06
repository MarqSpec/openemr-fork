import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {
  CANARY,
  TEST_PATIENT_ID,
  immunization,
  operationOutcome,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme} from '../../../theme/theme';
import {ImmunizationsCard} from './ImmunizationsCard';

// reference: REQUIREMENTS.md FR-CARD-IMM-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5 ·
// INTERFACES.md API-23 · REQUIREMENTS.md SCR-DASH-IMM · REQUIREMENTS.md BUG-51, BUG-59, BUG-60 ·
// REQUIREMENTS.md W-3, W-5

const OTHER_PATIENT_ID = 'test-patient-0002';

const NOT_DONE =
  'Not marked completed in OpenEMR: may have been refused, not given, or not recorded';

/** A CVX coding as OpenEMR sends it: the long CVX name as its display, never `text` (BUG-60). */
const cvx = (code: string, display?: string) => ({
  coding: [
    {
      system: 'http://hl7.org/fhir/sid/cvx',
      code,
      ...(display === undefined ? {} : {display}),
    },
  ],
});

interface Answers {
  readonly immunizations?: readonly unknown[];
  readonly response?: () => Response | Promise<Response>;
}

function answer(answers: Answers = {}) {
  const searches: URL[] = [];
  server.use(
    http.get('/bff/fhir/Immunization', ({request}) => {
      searches.push(new URL(request.url));
      if (answers.response) return answers.response();
      return HttpResponse.json(searchBundle(answers.immunizations ?? []));
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
  const view = render(wrap(<ImmunizationsCard patientId={patientId} />));
  return {
    onSessionOver,
    showPatient: (id: string) => {
      view.rerender(wrap(<ImmunizationsCard patientId={id} />));
    },
  };
}

const card = () => screen.getByRole('region', {name: 'Immunizations'});

/** The listed immunizations, top to bottom, each as its text: "{vaccine} {date}", then any note. */
async function shownRows(): Promise<string[]> {
  const list = await within(card()).findByRole('list');
  return within(list)
    .getAllByRole('listitem')
    .map(item => item.textContent);
}

describe('given the Immunizations read (API-23)', () => {
  it('when the card loads, then it searches this patient’s immunizations and sends nothing else — OpenEMR has no date or status search here', async () => {
    const {searches} = answer({immunizations: [immunization()]});
    renderCard();
    await within(card()).findByText('Test influenza vaccine, injectable');

    expect(searches).toHaveLength(1);
    const params = searches[0]?.searchParams;
    expect(params?.getAll('patient')).toEqual([TEST_PATIENT_ID]);
    expect([...(params?.keys() ?? [])]).toEqual(['patient']);
  });

  it('when the patient id is not a FHIR id, then nothing is sent and the card says it could not load immunizations', async () => {
    const {searches} = answer();
    renderCard('../Patient');

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load immunizations.",
    );
    expect(searches).toHaveLength(0);
  });
});

describe('given the immunizations legacy lists (SCR-DASH-IMM)', () => {
  it('when the card loads, then each immunization is its vaccine and administered date, newest first as legacy orders them', async () => {
    answer({
      immunizations: [
        immunization({
          id: 'i-older',
          vaccineCode: cvx('115', 'Test tetanus vaccine'),
          occurrenceDateTime: '2019-05-02T10:00:00-04:00',
        }),
        immunization({id: 'i-newest'}),
        immunization({
          id: 'i-middle',
          vaccineCode: cvx('03', 'Test measles vaccine'),
          occurrenceDateTime: '2023-01-15T11:00:00-05:00',
        }),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-04',
      'Test measles vaccine 2023-01-15',
      'Test tetanus vaccine 2019-05-02',
    ]);
  });

  it('when the patient has no immunizations, then the card reads "None", as legacy does', async () => {
    answer({immunizations: []});
    renderCard();

    expect(await within(card()).findByText('None')).toBeInTheDocument();
    expect(within(card()).queryByRole('list')).not.toBeInTheDocument();
  });

  it('when an immunization was entered in error, then it is not listed, as legacy hides it (BUG-59)', async () => {
    answer({
      immunizations: [
        immunization({
          id: 'i-error',
          status: 'entered-in-error',
          vaccineCode: cvx('115', 'Test tetanus vaccine'),
        }),
        immunization(),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-04',
    ]);
    expect(
      within(card()).queryByText('Test tetanus vaccine'),
    ).not.toBeInTheDocument();
  });

  it('when every immunization was entered in error, then the card reads "None"', async () => {
    answer({immunizations: [immunization({status: 'entered-in-error'})]});
    renderCard();

    expect(await within(card()).findByText('None')).toBeInTheDocument();
  });

  it('when OpenEMR sends one as not-done, then it is still listed, with a note in words that it is not marked completed — never the "patient objection" OpenEMR makes up (BUG-59: err toward showing)', async () => {
    answer({
      immunizations: [
        immunization({
          status: 'not-done',
          statusReason: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason',
                code: 'PATOBJ',
                display: 'patient objection',
              },
            ],
          },
        }),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      `Test influenza vaccine, injectable 2025-10-04${NOT_DONE}`,
    ]);
    expect(card()).not.toHaveTextContent(/objection/i);
  });

  it('when a completed immunization is listed, then it carries no status note', async () => {
    answer({immunizations: [immunization()]});
    renderCard();
    await shownRows();

    expect(card()).not.toHaveTextContent(NOT_DONE);
  });
});

describe('given OpenEMR’s wall-clock dates (BUG-51)', () => {
  it('when the administered date carries an offset far from the device’s, then the date shown is the one recorded, never shifted', async () => {
    answer({
      immunizations: [
        immunization({
          id: 'i-east',
          occurrenceDateTime: '2025-10-04T00:30:00+14:00',
        }),
        immunization({
          id: 'i-west',
          vaccineCode: cvx('115', 'Test tetanus vaccine'),
          occurrenceDateTime: '2025-03-01T23:30:00-12:00',
        }),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-04',
      'Test tetanus vaccine 2025-03-01',
    ]);
  });

  it('when two immunizations’ offsets disagree, then they are ordered by the time recorded, not the instant the offsets imply', async () => {
    answer({
      immunizations: [
        // Recorded earlier on the wall clock, though its instant is the later one.
        immunization({
          id: 'i-earlier',
          vaccineCode: cvx('115', 'Test tetanus vaccine'),
          occurrenceDateTime: '2025-10-04T23:00:00-12:00',
        }),
        immunization({
          id: 'i-later',
          occurrenceDateTime: '2025-10-05T00:30:00+14:00',
        }),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-05',
      'Test tetanus vaccine 2025-10-04',
    ]);
  });

  it('when an immunization has no administered date, then it is still listed, "Date not recorded", after the dated ones', async () => {
    answer({
      immunizations: [
        immunization({
          id: 'i-undated',
          vaccineCode: cvx('115', 'Test tetanus vaccine'),
          occurrenceDateTime: undefined,
        }),
        immunization(),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-04',
      'Test tetanus vaccine Date not recorded',
    ]);
  });

  it('when the administered date is not a calendar date, then the vaccine is still listed, its date "Date unreadable; check OpenEMR", after the dated ones', async () => {
    answer({
      immunizations: [
        immunization({
          id: 'i-unreadable',
          vaccineCode: cvx('115', 'Test tetanus vaccine'),
          occurrenceDateTime: '-0001-11-30T00:00:00-05:00',
        }),
        immunization(),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-04',
      'Test tetanus vaccine Date unreadable; check OpenEMR',
    ]);
  });
});

describe('given the vaccine names OpenEMR sends (BUG-60)', () => {
  it('when the CVX coding has no display, then the vaccine reads as its CVX code', async () => {
    answer({immunizations: [immunization({vaccineCode: cvx('150')})]});
    renderCard();

    expect(await shownRows()).toEqual(['CVX 150 2025-10-04']);
  });

  it('when no CVX code was recorded, so OpenEMR sends no vaccineCode at all, then the immunization is still listed, "Vaccine name not sent by OpenEMR"', async () => {
    answer({immunizations: [immunization({vaccineCode: undefined})]});
    renderCard();

    expect(await shownRows()).toEqual([
      'Vaccine name not sent by OpenEMR 2025-10-04',
    ]);
  });

  it('when OpenEMR repeats an immunization under the same id with the same name (the site join, BUG-60), then it is listed once, by that name', async () => {
    answer({immunizations: [immunization(), immunization()]});
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-04',
    ]);
  });

  it.each([
    [
      'the right name first',
      ['Test influenza vaccine, injectable', 'Test unrelated code text'],
    ],
    [
      'a wrong name first',
      ['Test unrelated code text', 'Test influenza vaccine, injectable'],
    ],
  ])(
    'when OpenEMR repeats an immunization under the same id with two names (%s — the codes join has no code type, BUG-60), then it is listed once as its CVX code, never a name that may be another code type’s',
    async (_order, names) => {
      answer({
        immunizations: names.map(name =>
          immunization({vaccineCode: cvx('150', name)}),
        ),
      });
      renderCard();

      expect(await shownRows()).toEqual(['CVX 150 2025-10-04']);
      expect(card()).not.toHaveTextContent('Test unrelated code text');
    },
  );
});

describe('given an entry that does not parse (FR-CARD-3)', () => {
  it('when one immunization is malformed, then it is "Could not display this item", after the others, and no field value leaks', async () => {
    answer({
      immunizations: [
        immunization({id: 'i-bad', status: CANARY}),
        immunization(),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-04',
      '⚠ Could not display this item',
    ]);
    expect(card()).not.toHaveTextContent(CANARY);
  });
});

describe('given a Bundle that says it holds more than it sent', () => {
  it('when its total is above the entries, then the list ends in "More immunizations not shown", after the sorted rows — a partial list is never shown as whole', async () => {
    server.use(
      http.get('/bff/fhir/Immunization', () =>
        HttpResponse.json({
          ...searchBundle([
            immunization({
              id: 'i-older',
              vaccineCode: cvx('115', 'Test tetanus vaccine'),
              occurrenceDateTime: '2019-05-02T10:00:00-04:00',
            }),
            immunization(),
          ]),
          total: 5,
        }),
      ),
    );
    renderCard();

    expect(await shownRows()).toEqual([
      'Test influenza vaccine, injectable 2025-10-04',
      'Test tetanus vaccine 2019-05-02',
      '⚠ More immunizations not shown',
    ]);
  });
});

describe('given the read does not succeed (W-5, FR-AUTH-5)', () => {
  it('when the read is refused (403), then it says the user is not authorised, with no retry', async () => {
    answer({
      response: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view immunizations. Access is controlled in OpenEMR.",
    );
    expect(
      within(card()).queryByRole('button', {name: 'Try again'}),
    ).not.toBeInTheDocument();
  });

  it('when the read fails on the server, then it says so with "Try again", which reloads the list', async () => {
    let fail = true;
    answer({
      response: () =>
        fail
          ? HttpResponse.json(operationOutcome('exception'), {status: 500})
          : HttpResponse.json(searchBundle([immunization()])),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load immunizations (server error).",
    );
    fail = false;
    await userEvent.click(
      within(card()).getByRole('button', {name: 'Try again'}),
    );
    expect(
      await within(card()).findByText('Test influenza vaccine, injectable'),
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
    expect(within(card()).queryByRole('list')).not.toBeInTheDocument();
    expect(within(card()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('when the answer is not a Bundle, then the card says it could not load immunizations', async () => {
    answer({response: () => HttpResponse.json(immunization())});
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load immunizations.",
    );
  });
});

describe('given the chart switches to another patient', () => {
  it('when it does, then that patient’s immunizations are read and the previous patient’s are never shown', async () => {
    const searches: string[] = [];
    server.use(
      http.get('/bff/fhir/Immunization', ({request}) => {
        const patient = new URL(request.url).searchParams.get('patient') ?? '';
        searches.push(patient);
        return HttpResponse.json(
          searchBundle(
            patient === OTHER_PATIENT_ID
              ? [
                  immunization({
                    id: 'i-other',
                    vaccineCode: cvx('115', 'Test tetanus vaccine'),
                  }),
                ]
              : [immunization()],
          ),
        );
      }),
    );
    const {showPatient} = renderCard();
    await within(card()).findByText('Test influenza vaccine, injectable');

    showPatient(OTHER_PATIENT_ID);

    expect(
      within(card()).queryByText('Test influenza vaccine, injectable'),
    ).not.toBeInTheDocument();
    expect(
      await within(card()).findByText('Test tetanus vaccine'),
    ).toBeInTheDocument();
    expect(searches).toEqual([TEST_PATIENT_ID, OTHER_PATIENT_ID]);
  });
});
