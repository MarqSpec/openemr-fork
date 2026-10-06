import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {delay, http, HttpResponse} from 'msw';
import {describe, expect, it, vi} from 'vitest';

import {createQueryClient} from '../../../api/query_client';
import {blockingAxeViolations} from '../../../test/axe';
import {
  TEST_PATIENT_ID,
  condition,
  operationOutcome,
  searchBundle,
} from '../../../test/fhir_fixtures';
import {server} from '../../../test/msw_server';
import {createAppTheme, type ThemeMode} from '../../../theme/theme';
import {ProblemListCard} from './ProblemListCard';

// reference: REQUIREMENTS.md FR-CARD-PRB-1, FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-CARD-6 ·
// INTERFACES.md API-14 · REQUIREMENTS.md SCR-DASH-PRB · REQUIREMENTS.md W-5, W-12

const clinical = (code: string) => ({
  coding: [
    {
      system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
      code,
    },
  ],
});

/** 2026-09-25, mid-afternoon local time: "now" for every end-date comparison below. */
const NOW = () => new Date(2026, 8, 25, 15, 0);

/**
 * An end date as OpenEMR sends it: the server's wall-clock midnight stamped with the server's current offset
 * (`getLocalDateAsUTC`) — not an instant (KNOWN_BUGS BUG-51).
 */
const endDate = (calendarDate: string, offset = '-04:00') =>
  `${calendarDate}T00:00:00${offset}`;

function renderCard(
  resources: readonly unknown[] | (() => Response | Promise<Response>),
  mode: ThemeMode = 'light',
) {
  const requests: URL[] = [];
  server.use(
    http.get('/bff/fhir/Condition', ({request}) => {
      requests.push(new URL(request.url));
      return typeof resources === 'function'
        ? resources()
        : HttpResponse.json(searchBundle(resources));
    }),
  );
  const client = createQueryClient({onSessionOver: vi.fn(), retryDelayMs: 0});
  const {container, unmount} = render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={createAppTheme(mode)}>
        <ProblemListCard patientId={TEST_PATIENT_ID} clock={NOW} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return {requests, container, unmount, client};
}

async function shownProblems(): Promise<(string | null)[]> {
  const region = await screen.findByRole('region', {name: 'Problem List'});
  const list = await within(region).findByRole('list');
  return within(list)
    .getAllByRole('listitem')
    .map(row => row.textContent);
}

// Legacy shows a problem whose end date is empty or still to come, whatever its Occurrence (SCREEN_AUDIT
// SCR-DASH; demographics.php filterActiveIssues). OpenEMR sets abatementDateTime from that end date but sends
// clinicalStatus "resolved" for Occurrence "First" (KNOWN_BUGS BUG-43), so the card reads the end date, not the
// status.
describe('given problems with and without an end date (review)', () => {
  it('when the card loads, then an open problem OpenEMR calls "resolved" (Occurrence First, no end date) is shown', async () => {
    renderCard([
      condition({
        code: {text: 'First-occurrence problem'},
        clinicalStatus: clinical('resolved'),
      }),
    ]);

    expect(await shownProblems()).toEqual([
      'First-occurrence problem2020-02-03',
    ]);
  });

  it('when a problem ended in the past, then it is hidden, and one ending later is shown, as the legacy card does', async () => {
    renderCard([
      condition({
        code: {text: 'Ended problem'},
        clinicalStatus: clinical('inactive'),
        abatementDateTime: endDate('2025-01-10'),
      }),
      condition({
        code: {text: 'Ending later'},
        clinicalStatus: clinical('resolved'),
        abatementDateTime: endDate('2027-01-10'),
        onsetDateTime: undefined,
      }),
    ]);

    expect(await shownProblems()).toEqual(['Ending later']);
  });

  it('when a problem ends today, then it is hidden (legacy compares midnight of the end date with now)', async () => {
    renderCard([
      condition({
        code: {text: 'Ends today'},
        clinicalStatus: clinical('inactive'),
        abatementDateTime: endDate('2026-09-25'),
      }),
      condition({code: {text: 'Still open'}, onsetDateTime: undefined}),
    ]);

    expect(await shownProblems()).toEqual(['Still open']);
  });

  // Each pair carries +14:00 and -12:00, so an instant comparison fails one of them whatever the runner's zone.
  it('when end dates carry extreme offsets, then tomorrow is still to come and today has passed, read as wall-clock (BUG-51)', async () => {
    renderCard([
      condition({
        code: {text: 'Ends tomorrow'},
        abatementDateTime: endDate('2026-09-26', '+14:00'),
        onsetDateTime: undefined,
      }),
      condition({
        code: {text: 'Ended today'},
        abatementDateTime: endDate('2026-09-25', '-12:00'),
        onsetDateTime: undefined,
      }),
    ]);

    expect(await shownProblems()).toEqual(['Ends tomorrow']);
  });

  it('when an onset date is midnight at +14:00 or -12:00, then it shows the calendar date OpenEMR recorded (BUG-51)', async () => {
    renderCard([
      condition({
        code: {text: 'East'},
        onsetDateTime: '2019-03-10T00:00:00+14:00',
      }),
      condition({
        code: {text: 'West'},
        onsetDateTime: '2019-03-10T23:59:59-12:00',
      }),
    ]);

    expect(await shownProblems()).toEqual(['East2019-03-10', 'West2019-03-10']);
  });

  it('when a problem has no clinical status and no end date, then it is shown, not dropped', async () => {
    renderCard([
      condition({
        code: {text: 'No status'},
        clinicalStatus: undefined,
        onsetDateTime: undefined,
      }),
    ]);

    expect(await shownProblems()).toEqual(['No status']);
  });

  it('when a problem is a recurrence with no end date, then it is shown with its onset date (FR-CARD-PRB-1)', async () => {
    renderCard([
      condition({
        code: {text: 'Recurring problem'},
        clinicalStatus: clinical('recurrence'),
        onsetDateTime: '2014-05-06',
      }),
    ]);

    expect(await shownProblems()).toEqual(['Recurring problem2014-05-06']);
  });

  // An end date that cannot be read errs toward showing, never hiding. OpenEMR's value is checked at the
  // boundary, so a malformed one makes that problem a "Could not display this item" row in its place (FR-CARD-3):
  // the clinician sees something is there, and nothing is judged ended on a guess.
  it.each([
    'not a date',
    '2026-13-45T00:00:00-04:00',
    '2026-09-25T00:00:00',
    '25/09/2026',
  ])(
    'when a problem’s end date cannot be read (%j), then it is not hidden: a "Could not display this item" row stands in its place (review)',
    async value => {
      renderCard([
        condition({code: {text: 'Still open'}, onsetDateTime: undefined}),
        condition({
          id: 'c-bad-end',
          code: {text: 'Unreadable end'},
          onsetDateTime: undefined,
          abatementDateTime: value,
        }),
        condition({
          code: {text: 'Ended problem'},
          abatementDateTime: endDate('2025-01-10'),
        }),
      ]);

      expect(await shownProblems()).toEqual([
        'Still open',
        expect.stringContaining('Could not display this item'),
      ]);
    },
  );
});

describe('given the Problem List read', () => {
  it('when the card loads, then it asks for problem-list items for this patient (API-14)', async () => {
    const {requests} = renderCard([condition()]);
    await screen.findByText('Test problem A');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get('patient')).toBe(TEST_PATIENT_ID);
    expect(requests[0]?.searchParams.get('category')).toBe('problem-list-item');
  });
});

describe('given a patient whose only problems have ended', () => {
  it('when the card loads, then it shows the legacy empty wording (FR-CARD-4)', async () => {
    renderCard([
      condition({
        clinicalStatus: clinical('inactive'),
        abatementDateTime: endDate('2024-06-01'),
      }),
    ]);

    const region = await screen.findByRole('region', {name: 'Problem List'});
    expect(
      await within(region).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
  });
});

describe('given a problem with no title text but a coded display', () => {
  it('when the card loads, then it shows the coded display', async () => {
    renderCard([
      condition({
        code: {coding: [{system: 'urn:test', code: 'X1', display: 'Coded A'}]},
      }),
    ]);

    expect(await screen.findByText('Coded A')).toBeInTheDocument();
  });
});

// Legacy lists the card in `lists.begdate` order, oldest first (PatientIssuesService::search, ORDER BY
// lists.begdate), a problem with no begin date first (MySQL sorts NULL first); OpenEMR's FHIR search has no
// ORDER BY, so the card sorts.
describe('given problems the server returns out of onset order (SCREEN_AUDIT SCR-DASH-PRB)', () => {
  it('when the card loads, then they are listed oldest onset first, an undated one before them, as legacy orders them', async () => {
    renderCard([
      condition({
        id: 'c-1',
        code: {text: 'Newest'},
        onsetDateTime: '2024-03-01T00:00:00-05:00',
      }),
      condition({id: 'c-2', code: {text: 'Undated'}, onsetDateTime: undefined}),
      condition({
        id: 'c-3',
        code: {text: 'Oldest'},
        onsetDateTime: '2010-07-15T00:00:00-04:00',
      }),
      condition({
        id: 'c-4',
        code: {text: 'Middle'},
        onsetDateTime: '2018-01-09T00:00:00-05:00',
      }),
    ]);

    expect(await shownProblems()).toEqual([
      'Undated',
      'Oldest2010-07-15',
      'Middle2018-01-09',
      'Newest2024-03-01',
    ]);
  });

  it('when onsets carry +14:00 and -12:00, then they are ordered by the wall-clock time OpenEMR recorded, not by instant (BUG-51)', async () => {
    renderCard([
      condition({
        id: 'c-east',
        code: {text: 'Nine'},
        onsetDateTime: '2019-03-10T09:00:00+14:00',
      }),
      condition({
        id: 'c-west',
        code: {text: 'Eight'},
        onsetDateTime: '2019-03-10T08:00:00-12:00',
      }),
    ]);

    expect(await shownProblems()).toEqual([
      'Eight2019-03-10',
      'Nine2019-03-10',
    ]);
  });

  it('when one of them does not parse, then "Could not display this item" is still shown, after the problems it cannot be dated against (FR-CARD-3)', async () => {
    renderCard([
      condition({
        id: 'c-1',
        code: {text: 'Later'},
        onsetDateTime: '2022-01-01T00:00:00-05:00',
      }),
      {resourceType: 'Condition', id: 'c-bad'},
      condition({
        id: 'c-3',
        code: {text: 'Earlier'},
        onsetDateTime: '2012-01-01T00:00:00-05:00',
      }),
    ]);

    expect(await shownProblems()).toEqual([
      'Earlier2012-01-01',
      'Later2022-01-01',
      expect.stringContaining('Could not display this item'),
    ]);
  });
});

// Legacy reads "None" when the list was ever touched (`lists_touch`: marked none, or any problem saved through the
// issue dialog) and "Nothing Recorded" otherwise. OpenEMR's FHIR and REST expose no such flag (KNOWN_BUGS BUG-46),
// so the card never claims "None": it cannot know the list was reviewed.
describe('given a patient with no problems at all (FR-CARD-4)', () => {
  it('when the search returns an empty Bundle, then the card reads "Nothing Recorded", never an unsupported "None"', async () => {
    renderCard([]);

    const region = await screen.findByRole('region', {name: 'Problem List'});
    expect(
      await within(region).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
    expect(within(region).queryByText('None')).not.toBeInTheDocument();
    expect(within(region).queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('given the Problem List read in its other states (FR-CARD-1, FR-AUTH-5)', () => {
  it('when the read is in flight, then the card body says it is loading problems', async () => {
    renderCard(() => new Promise<Response>(() => undefined));

    const region = await screen.findByRole('region', {name: 'Problem List'});
    expect(
      await within(region).findByText('Loading problems…'),
    ).toBeInTheDocument();
  });

  it('when the user may not read problems (403), then it says so and offers no retry', async () => {
    renderCard(() =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );

    const region = await screen.findByRole('region', {name: 'Problem List'});
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view problems. Access is controlled in OpenEMR.",
    );
    expect(
      within(region).queryByRole('button', {name: 'Try again'}),
    ).not.toBeInTheDocument();
  });

  it('when the server fails (5xx), then it shows an error with a retry, never "Nothing Recorded"', async () => {
    renderCard(() =>
      HttpResponse.json(operationOutcome('exception'), {status: 500}),
    );

    const region = await screen.findByRole('region', {name: 'Problem List'});
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "Couldn't load problems (server error).",
    );
    expect(
      within(region).getByRole('button', {name: 'Try again'}),
    ).toBeInTheDocument();
    expect(
      within(region).queryByText('Nothing Recorded'),
    ).not.toBeInTheDocument();
  });
});

const UNCONFIRMED = {
  coding: [
    {
      system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
      code: 'unconfirmed',
      display: 'Unconfirmed',
    },
  ],
};

async function openDetail(name: string) {
  const region = await screen.findByRole('region', {name: 'Problem List'});
  const row = await within(region).findByRole('button', {
    name: new RegExp(`^${name}`),
  });
  await userEvent.click(row);
  return {row, dialog: await screen.findByRole('dialog', {name})};
}

/** The dialog's description list as term → definition text. */
function detailFields(dialog: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    within(dialog)
      .queryAllByRole('term')
      .map(term => [
        term.textContent,
        term.nextElementSibling?.textContent ?? '',
      ]),
  );
}

// W-12 / FR-CARD-6: a read-only dialog of what API-14 already returned. `clinicalStatus` is left out because
// OpenEMR sends "resolved" for an open first occurrence (BUG-43), and `recordedDate` because OpenEMR fills it from
// the begin date, so it would repeat the onset as a "recorded" date.
describe('given a problem on the card (FR-CARD-6, W-12)', () => {
  it('when its onset and end date are midnight at +14:00 and -12:00, then the detail shows the dates OpenEMR recorded (BUG-51)', async () => {
    renderCard([
      condition({
        code: {text: 'Offset problem'},
        onsetDateTime: '2014-05-06T00:00:00+14:00',
        abatementDateTime: '2027-01-10T00:00:00-12:00',
      }),
    ]);

    const {dialog} = await openDetail('Offset problem');

    expect(detailFields(dialog)).toMatchObject({
      Onset: '2014-05-06',
      'End date': '2027-01-10',
    });
  });

  it('when its row is tapped, then a modal dialog named by the problem shows onset, end date, verification, code and note, with nothing fetched anew', async () => {
    const {requests} = renderCard([
      condition({
        code: {
          text: 'Synthetic hypertension',
          coding: [
            {
              system: 'http://hl7.org/fhir/sid/icd-10-cm',
              code: 'Z00.0',
              display: 'Synthetic code',
            },
          ],
        },
        clinicalStatus: clinical('resolved'),
        verificationStatus: UNCONFIRMED,
        onsetDateTime: '2014-05-06T00:00:00-04:00',
        abatementDateTime: '2027-01-10T00:00:00-05:00',
        recordedDate: '2014-05-06T00:00:00-04:00',
        note: [{text: 'Synthetic note A'}],
      }),
    ]);

    const {dialog} = await openDetail('Synthetic hypertension');

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(detailFields(dialog)).toEqual({
      Onset: '2014-05-06',
      'End date': '2027-01-10',
      Verification: 'Unconfirmed',
      Code: 'Z00.0 Synthetic code',
      Note: 'Synthetic note A',
    });
    expect(within(dialog).queryByText(/resolved/i)).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);
  });

  it('when the problem carries only a title, then the dialog lists no fields rather than inventing any (BUG-41 pattern)', async () => {
    renderCard([
      condition({
        code: {text: 'Bare problem'},
        onsetDateTime: undefined,
        clinicalStatus: undefined,
      }),
    ]);

    const {dialog} = await openDetail('Bare problem');

    expect(detailFields(dialog)).toEqual({});
    expect(
      within(dialog).getByText('Nothing more is recorded for this problem.'),
    ).toBeInTheDocument();
  });

  it('when Escape is pressed, then the dialog closes and focus returns to the row', async () => {
    renderCard([condition({code: {text: 'Escapable problem'}})]);

    const {row} = await openDetail('Escapable problem');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(row).toHaveFocus();
  });

  it('when Close is pressed, then the dialog closes and focus returns to the row', async () => {
    renderCard([condition({code: {text: 'Closable problem'}})]);

    const {row, dialog} = await openDetail('Closable problem');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Close'}));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(row).toHaveFocus();
  });
});

const ENCOUNTER_NOTICE =
  'Problems linked to an encounter may not be listed here. Check OpenEMR.';

// OpenEMR's problem-list search leaves out any problem linked to an encounter (KNOWN_BUGS BUG-47), so the card can
// miss an open problem legacy lists. Maintainer ruling: accept the gap for v1 and say so on the card, in
// words, wherever the list is shown — and only there, so it never reads as the reason for a failure.
describe('given the encounter-linked gap in the Problem List (BUG-47)', () => {
  it('when problems are shown, then the card says in words that encounter-linked problems may be missing, and the region is described by it', async () => {
    renderCard([condition({code: {text: 'Listed problem'}})]);

    const region = await screen.findByRole('region', {name: 'Problem List'});
    await within(region).findByText('Listed problem');
    expect(within(region).getByText(ENCOUNTER_NOTICE)).toBeVisible();
    expect(region).toHaveAccessibleDescription(ENCOUNTER_NOTICE);
  });

  it('when the list is empty ("Nothing Recorded"), then the notice is still shown, because an empty list may be the gap itself', async () => {
    renderCard([]);

    const region = await screen.findByRole('region', {name: 'Problem List'});
    await within(region).findByText('Nothing Recorded');
    expect(within(region).getByText(ENCOUNTER_NOTICE)).toBeVisible();
    expect(region).toHaveAccessibleDescription(ENCOUNTER_NOTICE);
  });

  it('when the read is in flight, then no notice is shown yet', async () => {
    renderCard(() => new Promise<Response>(() => undefined));

    const region = await screen.findByRole('region', {name: 'Problem List'});
    await within(region).findByText('Loading problems…');
    expect(
      within(region).queryByText(ENCOUNTER_NOTICE),
    ).not.toBeInTheDocument();
    expect(region).not.toHaveAccessibleDescription();
  });

  it('when the user may not read problems (403), then no notice is shown beside the not-authorised alert', async () => {
    renderCard(() =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );

    const region = await screen.findByRole('region', {name: 'Problem List'});
    await within(region).findByRole('alert');
    expect(
      within(region).queryByText(ENCOUNTER_NOTICE),
    ).not.toBeInTheDocument();
    expect(region).not.toHaveAccessibleDescription();
  });

  it('when the server fails (5xx), then no notice is shown beside the error', async () => {
    renderCard(() =>
      HttpResponse.json(operationOutcome('exception'), {status: 500}),
    );

    const region = await screen.findByRole('region', {name: 'Problem List'});
    await within(region).findByRole('alert');
    expect(
      within(region).queryByText(ENCOUNTER_NOTICE),
    ).not.toBeInTheDocument();
    expect(region).not.toHaveAccessibleDescription();
  });

  // the notice belongs to the rows, so a refresh (FR-CARD-5 invalidates every card) must not part them.
  it('when a refresh is in flight, then the problems already shown keep the notice', async () => {
    let refreshed = false;
    const {client} = renderCard(async () => {
      if (refreshed) await delay('infinite');
      return HttpResponse.json(
        searchBundle([condition({code: {text: 'Listed problem'}})]),
      );
    });
    const region = await screen.findByRole('region', {name: 'Problem List'});
    await within(region).findByText('Listed problem');

    refreshed = true;
    void client.refetchQueries();
    await waitFor(() => {
      expect(client.isFetching()).toBeGreaterThan(0);
    });

    expect(within(region).getByText('Listed problem')).toBeVisible();
    expect(within(region).getByText(ENCOUNTER_NOTICE)).toBeVisible();
    expect(region).toHaveAccessibleDescription(ENCOUNTER_NOTICE);
  });

  it('when a refresh fails, then the error replaces the stale problems and the notice goes with them; "Try again" brings both back', async () => {
    let calls = 0;
    const {client} = renderCard(() => {
      calls += 1;
      return calls === 2 || calls === 3
        ? HttpResponse.json(operationOutcome('exception'), {status: 500})
        : HttpResponse.json(
            searchBundle([condition({code: {text: 'Listed problem'}})]),
          );
    });
    const region = await screen.findByRole('region', {name: 'Problem List'});
    await within(region).findByText('Listed problem');

    await client.refetchQueries();

    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "Couldn't load problems (server error).",
    );
    expect(within(region).queryByText('Listed problem')).toBeNull();
    expect(within(region).queryByText(ENCOUNTER_NOTICE)).toBeNull();
    expect(region).not.toHaveAccessibleDescription();

    await userEvent.click(
      within(region).getByRole('button', {name: 'Try again'}),
    );
    await within(region).findByText('Listed problem');
    expect(within(region).getByText(ENCOUNTER_NOTICE)).toBeVisible();
    expect(region).toHaveAccessibleDescription(ENCOUNTER_NOTICE);
  });

  describe.each<ThemeMode>(['light', 'dark'])('in the %s theme', mode => {
    it('when the notice is shown with problems and with an empty list, then axe finds no serious or critical WCAG violations (NFR-A11Y-1)', async () => {
      const listed = renderCard(
        [condition({code: {text: 'Axe problem'}})],
        mode,
      );
      await screen.findByText(ENCOUNTER_NOTICE);
      expect(await blockingAxeViolations(listed.container)).toEqual([]);
      listed.unmount();

      const empty = renderCard([], mode);
      await within(empty.container).findByText(ENCOUNTER_NOTICE);
      expect(await blockingAxeViolations(empty.container)).toEqual([]);
    });
  });
});
