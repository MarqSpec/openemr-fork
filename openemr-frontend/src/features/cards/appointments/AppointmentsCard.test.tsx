import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {
  CANARY,
  TEST_PATIENT_ID,
  appointment,
  appointmentParticipant,
  operationOutcome,
  practitioner,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme} from '../../../theme/theme';
import {AppointmentsCard} from './AppointmentsCard';

// reference: REQUIREMENTS.md FR-CARD-APT-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5, NFR-PERF-3 ·
// INTERFACES.md API-18, API-24 · REQUIREMENTS.md SCR-DASH-APT · REQUIREMENTS.md BUG-10, BUG-31, BUG-32,
// BUG-35, BUG-51 · REQUIREMENTS.md W-3, W-5

/** Friday 2026-09-25, mid-afternoon on the tablet: "today" for the search. */
const NOW = () => new Date(2026, 8, 25, 15, 0);

const REPEATING_NOTICE =
  'Repeating appointments are listed once, on the day they start, and not at all once that day has passed. Check the calendar in OpenEMR.';

const pad = (value: number) => String(value).padStart(2, '0');

/** An October 2026 start as OpenEMR sends it: the wall-clock time stored, stamped with the server's current offset. */
const october = (day: number, hour = 9, minute = 0, offset = '-04:00') =>
  `2026-10-${pad(day)}T${pad(hour)}:${pad(minute)}:00${offset}`;

interface Answers {
  readonly appointments?: readonly unknown[];
  readonly response?: () => Response | Promise<Response>;
  readonly practitioner?: () => Response | Promise<Response>;
}

function answer(answers: Answers = {}) {
  const searches: URL[] = [];
  const practitionerReads: string[] = [];
  const otherReads: string[] = [];
  server.use(
    http.get('/bff/fhir/Appointment', ({request}) => {
      searches.push(new URL(request.url));
      if (answers.response) return answers.response();
      return HttpResponse.json(searchBundle(answers.appointments ?? []));
    }),
    http.get('/bff/fhir/Practitioner/:id', ({params}) => {
      practitionerReads.push(String(params.id));
      if (answers.practitioner) return answers.practitioner();
      return HttpResponse.json(practitioner({id: String(params.id)}));
    }),
    http.get('/bff/fhir/:type/:id', ({params}) => {
      otherReads.push(`${String(params.type)}/${String(params.id)}`);
      return HttpResponse.json(operationOutcome('forbidden'), {status: 403});
    }),
  );
  return {searches, practitionerReads, otherReads};
}

function renderCard(patientId = TEST_PATIENT_ID) {
  const onSessionOver = vi.fn();
  const client = createQueryClient({onSessionOver, retryDelayMs: 0});
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={createAppTheme('light')}>
        <AppointmentsCard patientId={patientId} clock={NOW} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return {onSessionOver};
}

const card = () => screen.getByRole('region', {name: 'Appointments'});

/** The listed appointments, top to bottom, each as its words: "{category} {when} {provider} {status}". */
async function shownRows(): Promise<string[]> {
  const list = await within(card()).findByRole('list');
  await waitFor(() => {
    expect(list).not.toHaveTextContent('Loading');
  });
  return within(list)
    .getAllByRole('listitem')
    .map(item => item.textContent.replace(/\s+/g, ' ').trim());
}

describe('given the Appointments read (API-24)', () => {
  it('when the card loads, then it searches this patient’s appointments from the tablet’s today and sends nothing else', async () => {
    const {searches} = answer({appointments: [appointment()]});
    renderCard();
    await within(card()).findByText('Test office visit');

    expect(searches).toHaveLength(1);
    const params = searches[0]?.searchParams;
    expect(params?.getAll('patient')).toEqual([TEST_PATIENT_ID]);
    expect(params?.getAll('date')).toEqual(['ge2026-09-25']);
    expect([...(params?.keys() ?? [])].sort()).toEqual(['date', 'patient']);
  });

  it('when the patient id is not a FHIR id, then nothing is sent and the card says it could not load appointments', async () => {
    const {searches} = answer();
    renderCard('../Patient');

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "Couldn't load appointments.",
    );
    expect(searches).toHaveLength(0);
  });
});

describe('given the future appointments legacy lists (SCR-DASH-APT)', () => {
  it('when the card loads, then each appointment is its category, day, date and time, provider and status, soonest first', async () => {
    answer({
      appointments: [
        appointment({
          id: 'a-later',
          start: october(20, 14, 5),
          appointmentType: {coding: [{code: 'x', display: 'Test follow-up'}]},
        }),
        appointment({id: 'a-sooner'}),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test office visit Mon 2026-10-12 09:30 Fakedoc Testdoctor Confirmed or reminder done',
      'Test follow-up Tue 2026-10-20 14:05 Fakedoc Testdoctor Confirmed or reminder done',
    ]);
  });

  it('when OpenEMR stamps a start with any offset, then the day and time are the wall clock it stored and the order is by that, never the instant (BUG-51)', async () => {
    answer({
      appointments: [
        // As instants this one is earlier (18:00Z on the 12th) — but the clinic booked it for 08:00 on the 13th.
        appointment({id: 'a-13th', start: october(13, 8, 0, '+14:00')}),
        appointment({id: 'a-12th', start: october(12, 20, 0, '-12:00')}),
        appointment({id: 'a-late', start: october(12, 23, 30, '+14:00')}),
      ],
    });
    renderCard();

    const rows = await shownRows();
    expect(rows.map(row => row.split(' Fakedoc')[0])).toEqual([
      'Test office visit Mon 2026-10-12 20:00',
      'Test office visit Mon 2026-10-12 23:30',
      'Test office visit Tue 2026-10-13 08:00',
    ]);
  });

  it('when appointments carry every status OpenEMR sends, then each is listed with its status in words naming every legacy status OpenEMR folds into it (BUG-31) — cancelled and no-show included, as legacy lists them', async () => {
    const statuses = [
      ['proposed', 'Scheduled'],
      ['pending', 'Pending or other status'],
      ['booked', 'Confirmed or reminder done'],
      ['arrived', 'Arrived or arrived late'],
      ['checked-in', 'In exam room or chart pulled'],
      ['fulfilled', 'Checked out or coding done'],
      ['cancelled', 'Cancelled or left without visit'],
      ['noshow', 'No show'],
      ['waitlist', 'Callback requested'],
    ] as const;
    answer({
      appointments: statuses.map(([status], index) =>
        appointment({id: `a-${status}`, status, start: october(index + 1)}),
      ),
    });
    renderCard();

    const rows = await shownRows();
    expect(rows).toHaveLength(statuses.length);
    for (const [index, [, words]] of statuses.entries()) {
      expect(rows[index]).toMatch(new RegExp(`Fakedoc Testdoctor ${words}$`));
    }
  });

  it('when the patient has no future appointments, then the card reads "No Appointments", as legacy does', async () => {
    answer({appointments: []});
    renderCard();

    expect(
      await within(card()).findByText('No Appointments'),
    ).toBeInTheDocument();
    expect(within(card()).queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('given more future appointments than legacy shows (FR-CARD-APT-1: default 10)', () => {
  it('when there are twelve on twelve days, then the first ten are listed and a line gives the day the next one is on', async () => {
    answer({
      appointments: Array.from({length: 12}, (_, index) =>
        appointment({id: `a-${String(index)}`, start: october(index + 1)}),
      ),
    });
    renderCard();

    const rows = await shownRows();
    expect(rows).toHaveLength(10);
    expect(rows[9]).toContain('Sat 2026-10-10 09:00');
    expect(
      within(card()).getByText(
        'More appointments from Sun 2026-10-11. Check OpenEMR.',
      ),
    ).toBeInTheDocument();
  });

  it('when the tenth shares its day with the next, then that whole day is listed, as legacy’s display sets do, and the line gives the day after', async () => {
    answer({
      appointments: [
        ...Array.from({length: 9}, (_, index) =>
          appointment({id: `a-${String(index)}`, start: october(index + 1)}),
        ),
        appointment({id: 'a-10-am', start: october(10, 9)}),
        appointment({id: 'a-10-pm', start: october(10, 15)}),
        appointment({id: 'a-later', start: october(22)}),
      ],
    });
    renderCard();

    const rows = await shownRows();
    expect(rows).toHaveLength(11);
    expect(rows[10]).toContain('Sat 2026-10-10 15:00');
    expect(
      within(card()).getByText(
        'More appointments from Thu 2026-10-22. Check OpenEMR.',
      ),
    ).toBeInTheDocument();
  });

  it('when there are exactly ten, then all are listed and no line says there are more', async () => {
    answer({
      appointments: Array.from({length: 10}, (_, index) =>
        appointment({id: `a-${String(index)}`, start: october(index + 1)}),
      ),
    });
    renderCard();

    expect(await shownRows()).toHaveLength(10);
    expect(within(card()).queryByText(/More appointments/)).toBeNull();
  });

  it('when an appointment has no readable start or does not parse, then it is listed after the dated ones however many there are — never cut by the limit', async () => {
    answer({
      appointments: [
        {resourceType: 'Appointment', id: 'a-bad', status: 'not-a-status'},
        appointment({id: 'a-undated', start: undefined, end: undefined}),
        appointment({id: 'a-garbled', start: `soon ${CANARY}`}),
        ...Array.from({length: 11}, (_, index) =>
          appointment({id: `a-${String(index)}`, start: october(index + 1)}),
        ),
      ],
    });
    renderCard();

    const rows = await shownRows();
    expect(rows).toHaveLength(13);
    expect(rows.slice(10)).toEqual([
      'Test office visit Date not recorded Fakedoc Testdoctor Confirmed or reminder done',
      'Test office visit Date unreadable; check OpenEMR Fakedoc Testdoctor Confirmed or reminder done',
      '⚠ Could not display this item',
    ]);
    expect(card()).not.toHaveTextContent(CANARY);
    expect(
      within(card()).getByText(
        'More appointments from Sun 2026-10-11. Check OpenEMR.',
      ),
    ).toBeInTheDocument();
  });
});

describe('given OpenEMR says it holds more appointments than it sent', () => {
  it('when the search total is above the entries and more than ten are dated, then the list still ends in "More appointments not shown" after the limit — never dropped', async () => {
    answer({
      response: () =>
        HttpResponse.json({
          ...searchBundle(
            Array.from({length: 12}, (_, index) =>
              appointment({
                id: `a-${String(index)}`,
                start: october(index + 1),
              }),
            ),
          ),
          total: 20,
        }),
    });
    renderCard();

    const rows = await shownRows();
    expect(rows).toHaveLength(11);
    expect(rows[10]).toBe('⚠ More appointments not shown');
    expect(
      within(card()).getByText(
        'More appointments from Sun 2026-10-11. Check OpenEMR.',
      ),
    ).toBeInTheDocument();
  });
});

describe('given the provider and category OpenEMR sends', () => {
  it('when one provider is on several appointments, then the name is read once (API-18, NFR-PERF-3)', async () => {
    const {practitionerReads} = answer({
      appointments: [
        appointment({id: 'a-1', start: october(1)}),
        appointment({id: 'a-2', start: october(2)}),
      ],
    });
    renderCard();

    expect(await shownRows()).toHaveLength(2);
    expect(practitionerReads).toEqual(['test-practitioner-0001']);
  });

  it('when the provider has no NPI, OpenEMR sends a Person/ it will not serve, so the provider reads "Name unavailable" and nothing is read (BUG-31)', async () => {
    const {practitionerReads, otherReads} = answer({
      appointments: [
        appointment({
          participant: [
            appointmentParticipant('PART', `Patient/${TEST_PATIENT_ID}`),
            appointmentParticipant('PPRF', 'Person/test-person-0001'),
          ],
        }),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test office visit Mon 2026-10-12 09:30 Name unavailable Confirmed or reminder done',
    ]);
    expect(practitionerReads).toEqual([]);
    expect(otherReads).toEqual([]);
  });

  it('when the practitioner read is refused (BUG-10), then the provider reads "Name unavailable" and the appointment still shows', async () => {
    answer({
      appointments: [appointment()],
      practitioner: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Test office visit Mon 2026-10-12 09:30 Name unavailable Confirmed or reminder done',
    ]);
  });

  it('when an appointment has no provider or no category, then each says it was not recorded', async () => {
    answer({
      appointments: [
        appointment({
          appointmentType: undefined,
          participant: [
            appointmentParticipant('PART', `Patient/${TEST_PATIENT_ID}`),
            appointmentParticipant('LOC', 'Location/test-location-0001'),
          ],
        }),
      ],
    });
    renderCard();

    expect(await shownRows()).toEqual([
      'Category not recorded Mon 2026-10-12 09:30 Provider not recorded Confirmed or reminder done',
    ]);
  });
});

describe('given OpenEMR does not repeat a repeating appointment (BUG-31)', () => {
  it('when the list is shown, then a line under it says repeating appointments may be missing', async () => {
    answer({appointments: [appointment()]});
    renderCard();

    expect(await within(card()).findByText(REPEATING_NOTICE)).toBeVisible();
  });

  it('when the patient has no future appointments, then the line is still there: a series begun before today is not sent at all', async () => {
    answer({appointments: []});
    renderCard();

    await within(card()).findByText('No Appointments');
    expect(within(card()).getByText(REPEATING_NOTICE)).toBeVisible();
  });
});

describe('given the read fails (W-5)', () => {
  it('when OpenEMR refuses it (403), then the card says the clinician is not authorised, and no notice claims a list', async () => {
    answer({
      response: () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    });
    renderCard();

    expect(await within(card()).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view appointments.",
    );
    expect(within(card()).queryByText(REPEATING_NOTICE)).toBeNull();
  });

  it('when the server fails, then the card offers to try again and shows no notice', async () => {
    answer({
      response: () =>
        HttpResponse.json(operationOutcome('exception'), {status: 500}),
    });
    renderCard();

    const alert = await within(card()).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load appointments");
    expect(
      within(alert).getByRole('button', {name: 'Try again'}),
    ).toBeInTheDocument();
    expect(within(card()).queryByText(REPEATING_NOTICE)).toBeNull();
  });

  it('when the session is over (401), then the card hands it to the session handler and shows nothing of its own', async () => {
    answer({
      response: () =>
        HttpResponse.json(operationOutcome('login'), {status: 401}),
    });
    const {onSessionOver} = renderCard();

    await waitFor(() => {
      expect(onSessionOver).toHaveBeenCalled();
    });
    expect(within(card()).queryByRole('alert')).toBeNull();
    expect(within(card()).queryByRole('list')).toBeNull();
  });
});
