import Typography from '@mui/material/Typography';
import {ThemeProvider} from '@mui/material/styles';
import {QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {delay, http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {describe, expect, it, vi} from 'vitest';

import {useAllergies, useProblems} from '../../api/fhir/hooks';
import type {AllergyIntolerance, Condition} from '../../api/fhir/schemas';
import {createQueryClient} from '../../api/query_client';
import {blockingAxeViolations} from '../../test/axe';
import {
  TEST_PATIENT_ID,
  allergy,
  condition,
  operationOutcome,
  searchBundle,
} from '../../test/fhir_fixtures';
import {server} from '../../test/msw_server';
import {createAppTheme, type ThemeMode} from '../../theme/theme';
import {CardItems, showsItems} from './CardItems';
import {CardBoundary, DashboardCard} from './DashboardCard';

// reference: REQUIREMENTS.md FR-CARD-1, FR-CARD-3, FR-CARD-4, FR-AUTH-5, NFR-A11Y-1, NFR-A11Y-2 ·
// REQUIREMENTS.md W-5

const ALLERGIES = '/bff/fhir/AllergyIntolerance';
const PROBLEMS = '/bff/fhir/Condition';

/** Answers a search in turn with `responses`, the last one repeating. */
function answer(path: string, ...responses: readonly (() => Response)[]) {
  let calls = 0;
  server.use(
    http.get(path, () => {
      const respond = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (respond === undefined) throw new Error('no response configured');
      return respond();
    }),
  );
}

const substance = (resource: AllergyIntolerance) => resource.code?.text ?? '';

/** A minimal card on the framework: the real API hook, the generic states, one line per item. */
function TestAllergiesCard(props: {
  readonly renderItem?: (resource: AllergyIntolerance) => ReactNode;
}): ReactNode {
  const query = useAllergies(TEST_PATIENT_ID);
  return (
    <DashboardCard title="Allergies">
      <CardItems
        query={query}
        subject="allergies"
        emptyText="Nothing Recorded"
        renderItem={props.renderItem ?? substance}
      />
    </DashboardCard>
  );
}

function TestProblemsCard(): ReactNode {
  const query = useProblems(TEST_PATIENT_ID);
  return (
    <DashboardCard title="Problem List">
      <CardItems
        query={query}
        subject="problems"
        emptyText="Nothing Recorded"
        renderItem={(resource: Condition) => resource.code?.text ?? ''}
      />
    </DashboardCard>
  );
}

function renderCards(
  cards: ReactNode,
  options: {mode?: ThemeMode; onSessionOver?: () => void} = {},
) {
  const client = createQueryClient({
    onSessionOver: options.onSessionOver ?? vi.fn(),
    retryDelayMs: 0,
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={createAppTheme(options.mode ?? 'light')}>
        {cards}
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return {...rendered, client};
}

const card = (name: string) => screen.getByRole('region', {name});
const findCard = (name: string) => screen.findByRole('region', {name});

describe('given a card on the dashboard (FR-CARD-1)', () => {
  it('when it renders, then it is a region named by its title, with the title as a level-2 heading', async () => {
    answer(ALLERGIES, () => HttpResponse.json(searchBundle([allergy()])));
    renderCards(<TestAllergiesCard />);

    const region = await findCard('Allergies');
    expect(
      within(region).getByRole('heading', {level: 2, name: 'Allergies'}),
    ).toBeInTheDocument();
  });

  it('when it renders, then its collapse control is a button that says it is expanded and names the body it controls', async () => {
    answer(ALLERGIES, () => HttpResponse.json(searchBundle([allergy()])));
    renderCards(<TestAllergiesCard />);

    const toggle = within(await findCard('Allergies')).getByRole('button', {
      name: 'Allergies',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const controlled = toggle.getAttribute('aria-controls') ?? '';
    expect(controlled).not.toBe('');
    expect(document.getElementById(controlled)).toBeInTheDocument();
  });

  it('when the collapse control is pressed, then the body hides, and pressing it again shows it (guards a card that cannot be collapsed)', async () => {
    answer(ALLERGIES, () => HttpResponse.json(searchBundle([allergy()])));
    renderCards(<TestAllergiesCard />);
    const region = await findCard('Allergies');
    expect(await within(region).findByText('Test substance A')).toBeVisible();
    const toggle = within(region).getByRole('button', {name: 'Allergies'});

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(region).getByText('Test substance A')).not.toBeVisible();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(region).getByText('Test substance A')).toBeVisible();
  });
});

describe('given the card read has not answered yet', () => {
  it('when the card renders, then its body is busy and says what is loading (guards a blank card while loading)', async () => {
    server.use(http.get(ALLERGIES, () => delay('infinite')));
    renderCards(<TestAllergiesCard />);

    const region = await findCard('Allergies');
    expect(within(region).getByText('Loading allergies…')).toBeInTheDocument();
    expect(
      within(region).getByText('Loading allergies…').closest('[aria-busy]'),
    ).toHaveAttribute('aria-busy', 'true');
  });
});

describe('given a card whose search returns an empty Bundle (FR-CARD-4)', () => {
  it('when the card loads, then it shows the legacy empty wording, not a blank body', async () => {
    answer(ALLERGIES, () => HttpResponse.json(searchBundle([])));
    renderCards(<TestAllergiesCard />);

    const region = await findCard('Allergies');
    expect(
      await within(region).findByText('Nothing Recorded'),
    ).toBeInTheDocument();
    expect(within(region).queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('given a card whose items include one that does not parse (FR-CARD-3)', () => {
  it('when the card loads, then "Could not display this item" takes that item\'s place, in server order', async () => {
    answer(ALLERGIES, () =>
      HttpResponse.json(
        searchBundle([
          allergy({code: {text: 'First substance'}}),
          allergy({criticality: 'catastrophic'}),
          allergy({code: {text: 'Third substance'}}),
        ]),
      ),
    );
    renderCards(<TestAllergiesCard />);

    const region = await findCard('Allergies');
    const list = await within(region).findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(row => row.textContent)).toEqual([
      'First substance',
      expect.stringContaining('Could not display this item'),
      'Third substance',
    ]);
  });
});

describe('given a card whose search says it holds more than it sent (BUG-7)', () => {
  it('when the card loads, then every item is shown and a last row says more are not shown (guards results dropped silently)', async () => {
    answer(ALLERGIES, () =>
      HttpResponse.json({
        ...searchBundle([allergy({code: {text: 'First substance'}})]),
        total: 4,
      }),
    );
    renderCards(<TestAllergiesCard />);

    const list = await within(await findCard('Allergies')).findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(row => row.textContent)).toEqual([
      'First substance',
      expect.stringContaining('More allergies not shown'),
    ]);
  });

  it('when no entry came back but total says some exist, then the card says more are not shown, never the empty wording', async () => {
    answer(ALLERGIES, () => HttpResponse.json({...searchBundle([]), total: 2}));
    renderCards(<TestAllergiesCard />);

    const region = await findCard('Allergies');
    expect(
      await within(region).findByText(/More allergies not shown/),
    ).toBeInTheDocument();
    expect(within(region).queryByText('Nothing Recorded')).toBeNull();
  });
});

describe('given a card the user is not authorised to see (403, FR-AUTH-5)', () => {
  it('when the card loads, then it says so in words and offers no retry (guards a retry loop on a refusal)', async () => {
    answer(ALLERGIES, () =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );
    renderCards(<TestAllergiesCard />);

    const region = await findCard('Allergies');
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "You're not authorised to view allergies. Access is controlled in OpenEMR.",
    );
    expect(
      within(region).queryByRole('button', {name: 'Try again'}),
    ).not.toBeInTheDocument();
  });
});

describe('given a card whose read fails on the server (5xx)', () => {
  it('when the card loads, then it shows an error with a retry, and retrying loads the items', async () => {
    answer(
      ALLERGIES,
      () => HttpResponse.json(operationOutcome('exception'), {status: 500}),
      () => HttpResponse.json(operationOutcome('exception'), {status: 500}),
      () => HttpResponse.json(searchBundle([allergy()])),
    );
    renderCards(<TestAllergiesCard />);

    const region = await findCard('Allergies');
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "Couldn't load allergies (server error).",
    );
    await userEvent.click(
      within(region).getByRole('button', {name: 'Try again'}),
    );
    expect(
      await within(region).findByText('Test substance A'),
    ).toBeInTheDocument();
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });
});

const CAVEAT = 'Some allergies may not be listed here.';

/** A card with a standing caveat that belongs to its items, as the Problem List's BUG-47 notice does. */
function TestCaveatCard(): ReactNode {
  const query = useAllergies(TEST_PATIENT_ID);
  return (
    <DashboardCard
      title="Allergies"
      notice={showsItems(query) ? CAVEAT : undefined}
    >
      <CardItems
        query={query}
        subject="allergies"
        emptyText="Nothing Recorded"
        renderItem={substance}
      />
    </DashboardCard>
  );
}

const serverError = () =>
  HttpResponse.json(operationOutcome('exception'), {status: 500});

// A caveat about the items must be on screen exactly when the items (or the empty wording) are: never beside a
// loading body or a failure, never missing beside rows. A separate change asked whether a failed refresh leaves stale rows
// on screen without it; CardItems' rule is that the failure replaces the rows, and `showsItems` is that rule.
describe('given a card whose caveat follows its items (showsItems)', () => {
  it('when the read answers with items or with none, then the caveat is shown with them', async () => {
    answer(ALLERGIES, () => HttpResponse.json(searchBundle([allergy()])));
    const listed = renderCards(<TestCaveatCard />);
    const region = await findCard('Allergies');
    await within(region).findByText('Test substance A');
    expect(within(region).getByText(CAVEAT)).toBeVisible();
    listed.unmount();

    answer(ALLERGIES, () => HttpResponse.json(searchBundle([])));
    renderCards(<TestCaveatCard />);
    const empty = await findCard('Allergies');
    await within(empty).findByText('Nothing Recorded');
    expect(within(empty).getByText(CAVEAT)).toBeVisible();
  });

  it('when the read is loading, refused (403) or failed (5xx), then no caveat is shown', async () => {
    server.use(http.get(ALLERGIES, () => delay('infinite')));
    const loading = renderCards(<TestCaveatCard />);
    await within(await findCard('Allergies')).findByText('Loading allergies…');
    expect(screen.queryByText(CAVEAT)).not.toBeInTheDocument();
    loading.unmount();

    for (const failure of [
      () => HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
      serverError,
    ]) {
      answer(ALLERGIES, failure);
      const failed = renderCards(<TestCaveatCard />);
      await within(await findCard('Allergies')).findByRole('alert');
      expect(screen.queryByText(CAVEAT)).not.toBeInTheDocument();
      failed.unmount();
    }
  });

  it('when a refresh is in flight, then the items already shown stay, and so does the caveat', async () => {
    let refreshed = false;
    server.use(
      http.get(ALLERGIES, async () => {
        if (refreshed) await delay('infinite');
        return HttpResponse.json(searchBundle([allergy()]));
      }),
    );
    const {client} = renderCards(<TestCaveatCard />);
    const region = await findCard('Allergies');
    await within(region).findByText('Test substance A');

    refreshed = true;
    void client.refetchQueries();
    await waitFor(() => {
      expect(client.isFetching()).toBeGreaterThan(0);
    });

    expect(within(region).getByText('Test substance A')).toBeVisible();
    expect(within(region).getByText(CAVEAT)).toBeVisible();
    expect(region).toHaveAccessibleDescription(CAVEAT);
  });

  it('when a refresh fails, then its error replaces the stale items and the caveat goes with them, and "Try again" brings both back', async () => {
    answer(
      ALLERGIES,
      () => HttpResponse.json(searchBundle([allergy()])),
      serverError,
      serverError,
      () => HttpResponse.json(searchBundle([allergy()])),
    );
    const {client} = renderCards(<TestCaveatCard />);
    const region = await findCard('Allergies');
    await within(region).findByText('Test substance A');

    await client.refetchQueries();

    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "Couldn't load allergies (server error).",
    );
    expect(within(region).queryByText('Test substance A')).toBeNull();
    expect(within(region).queryByText(CAVEAT)).toBeNull();
    expect(region).not.toHaveAccessibleDescription();

    await userEvent.click(
      within(region).getByRole('button', {name: 'Try again'}),
    );
    expect(
      await within(region).findByText('Test substance A'),
    ).toBeInTheDocument();
    expect(within(region).getByText(CAVEAT)).toBeVisible();
  });
});

describe('given the session is over (401)', () => {
  it('when the card loads, then it shows no error and no data — the app owns sign-in (FR-AUTH-5)', async () => {
    const onSessionOver = vi.fn();
    answer(ALLERGIES, () =>
      HttpResponse.json(operationOutcome('login'), {status: 401}),
    );
    renderCards(<TestAllergiesCard />, {onSessionOver});

    await waitFor(() => {
      expect(onSessionOver).toHaveBeenCalledOnce();
    });
    const region = card('Allergies');
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(region).queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('given two cards where one fails (FR-CARD-1: one failure never blocks another)', () => {
  it("when one card's read fails, then the other card still shows its items", async () => {
    answer(ALLERGIES, () =>
      HttpResponse.json(operationOutcome('exception'), {status: 500}),
    );
    answer(PROBLEMS, () =>
      HttpResponse.json(searchBundle([condition({code: {text: 'Problem A'}})])),
    );
    renderCards(
      <>
        <TestAllergiesCard />
        <TestProblemsCard />
      </>,
    );

    expect(
      await within(await findCard('Problem List')).findByText('Problem A'),
    ).toBeInTheDocument();
    expect(
      await within(card('Allergies')).findByRole('alert'),
    ).toBeInTheDocument();
  });

  it('when one card throws while rendering, then only that card shows "Couldn\'t display", with a retry, and the other still shows its items', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answer(ALLERGIES, () => HttpResponse.json(searchBundle([allergy()])));
    answer(PROBLEMS, () =>
      HttpResponse.json(searchBundle([condition({code: {text: 'Problem A'}})])),
    );
    renderCards(
      <>
        <TestAllergiesCard
          renderItem={() => {
            throw new Error('render failure');
          }}
        />
        <TestProblemsCard />
      </>,
    );

    const failed = await findCard('Allergies');
    expect(await within(failed).findByRole('alert')).toHaveTextContent(
      "Couldn't display this card.",
    );
    expect(
      within(failed).getByRole('button', {name: 'Try again'}),
    ).toBeInTheDocument();
    expect(
      within(failed).getByRole('button', {name: 'Allergies'}),
    ).toBeInTheDocument();
    expect(
      await within(card('Problem List')).findByText('Problem A'),
    ).toBeInTheDocument();
  });
});

/** A card whose data hook throws before its frame renders. */
function useBrokenRead(): never {
  throw new Error('hook failure');
}

function BrokenHookCard(): ReactNode {
  useBrokenRead();
}

describe('given a card whose data hook throws before its frame renders (review)', () => {
  it('when the dashboard renders, then that card shows "Couldn’t display" under its own title, with a retry, and the other card still shows its items', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answer(PROBLEMS, () =>
      HttpResponse.json(searchBundle([condition({code: {text: 'Problem A'}})])),
    );
    renderCards(
      <>
        <CardBoundary title="Allergies" patientId={TEST_PATIENT_ID}>
          <BrokenHookCard />
        </CardBoundary>
        <CardBoundary title="Problem List" patientId={TEST_PATIENT_ID}>
          <TestProblemsCard />
        </CardBoundary>
      </>,
    );

    const failed = await findCard('Allergies');
    expect(within(failed).getByRole('alert')).toHaveTextContent(
      "Couldn't display this card.",
    );
    expect(
      within(failed).getByRole('button', {name: 'Try again'}),
    ).toBeInTheDocument();
    expect(
      await within(card('Problem List')).findByText('Problem A'),
    ).toBeInTheDocument();
  });
});

const FAILING_PATIENT = 'test-patient-fails';
const NEXT_PATIENT = 'test-patient-next';

/** A card that throws before its frame renders — as its data hook would — for {@link FAILING_PATIENT} only. */
function HookFailsForOnePatient(props: {patientId: string}): ReactNode {
  if (props.patientId === FAILING_PATIENT) throw new Error('hook failure');
  return (
    <DashboardCard title="Allergies">
      <Typography>Allergies of {props.patientId}</Typography>
    </DashboardCard>
  );
}

/** A card body that throws while rendering for {@link FAILING_PATIENT} only; its frame renders. */
function BodyFailsForOnePatient(props: {patientId: string}): ReactNode {
  if (props.patientId === FAILING_PATIENT) throw new Error('render failure');
  return <Typography>Problems of {props.patientId}</Typography>;
}

function patientCards(patientId: string): ReactNode {
  return (
    <ThemeProvider theme={createAppTheme('light')}>
      <CardBoundary title="Allergies" patientId={patientId}>
        <HookFailsForOnePatient patientId={patientId} />
      </CardBoundary>
      <CardBoundary title="Problem List" patientId={patientId}>
        <DashboardCard title="Problem List">
          <BodyFailsForOnePatient patientId={patientId} />
        </DashboardCard>
      </CardBoundary>
    </ThemeProvider>
  );
}

// A card that failed for one patient must not keep that failure for the next: the chart switches in place, and
// neither the slot's boundary nor the body's may carry the last patient's error across.
describe('given cards that failed for one patient (review)', () => {
  it('when the chart switches to another patient without a remount, then both cards render for the new patient and neither still says "Couldn’t display"', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const {rerender} = render(patientCards(FAILING_PATIENT));
    expect(within(card('Allergies')).getByRole('alert')).toHaveTextContent(
      "Couldn't display this card.",
    );
    expect(within(card('Problem List')).getByRole('alert')).toHaveTextContent(
      "Couldn't display this card.",
    );

    rerender(patientCards(NEXT_PATIENT));

    expect(within(card('Allergies')).queryByRole('alert')).toBeNull();
    expect(
      within(card('Allergies')).getByText(`Allergies of ${NEXT_PATIENT}`),
    ).toBeInTheDocument();
    expect(within(card('Problem List')).queryByRole('alert')).toBeNull();
    expect(
      within(card('Problem List')).getByText(`Problems of ${NEXT_PATIENT}`),
    ).toBeInTheDocument();
  });

  it('when the same patient re-renders, then the failure stands until "Try again" or a patient change', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const {rerender} = render(patientCards(FAILING_PATIENT));

    rerender(patientCards(FAILING_PATIENT));

    expect(within(card('Allergies')).getByRole('alert')).toBeInTheDocument();
    expect(within(card('Problem List')).getByRole('alert')).toBeInTheDocument();
  });
});

describe.each(['light', 'dark'] as const)(
  'given the %s theme (NFR-A11Y-1)',
  mode => {
    // One spec per render: each axe run over the cards costs a few hundred milliseconds of CPU, and three in one
    // spec outran its 5 s on a loaded runner.
    it('when axe scans a card with items, a could-not-display item and an empty card, then it finds no serious or critical violations', async () => {
      answer(ALLERGIES, () =>
        HttpResponse.json(
          searchBundle([allergy(), allergy({criticality: 'catastrophic'})]),
        ),
      );
      answer(PROBLEMS, () => HttpResponse.json(searchBundle([])));
      const {container} = renderCards(
        <>
          <TestAllergiesCard />
          <TestProblemsCard />
        </>,
        {mode},
      );
      await within(await findCard('Allergies')).findByRole('list');
      await within(card('Problem List')).findByText('Nothing Recorded');
      expect(await blockingAxeViolations(container)).toEqual([]);
    });

    it('when axe scans a card that is not authorised and one that failed, then it finds no serious or critical violations', async () => {
      answer(ALLERGIES, () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
      );
      answer(PROBLEMS, () =>
        HttpResponse.json(operationOutcome('exception'), {status: 500}),
      );
      const failing = renderCards(
        <>
          <TestAllergiesCard />
          <TestProblemsCard />
        </>,
        {mode},
      );
      await within(await findCard('Allergies')).findByRole('alert');
      await within(card('Problem List')).findByRole('alert');
      expect(await blockingAxeViolations(failing.container)).toEqual([]);
    });

    it('when axe scans a card that is loading, then it finds no serious or critical violations', async () => {
      server.use(http.get(ALLERGIES, () => delay('infinite')));
      const loading = renderCards(<TestAllergiesCard />, {mode});
      await within(await findCard('Allergies')).findByText(
        'Loading allergies…',
      );
      expect(await blockingAxeViolations(loading.container)).toEqual([]);
    });
  },
);
