import type {QueryClient} from '@tanstack/react-query';
import {QueryClientProvider, useQuery} from '@tanstack/react-query';
import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {describe, expect, it, vi} from 'vitest';

import {server} from '../../test/msw_server';
import {
  TEST_PATIENT_ID,
  allergy,
  condition,
  operationOutcome,
  patient,
  practitioner,
  searchBundle,
} from '../../test/fhir_fixtures';
import {ApiError} from '../api_error';
import {createQueryClient} from '../query_client';
import {
  allergiesQuery,
  useAllergies,
  usePatient,
  usePractitioner,
  useProblems,
} from './hooks';
import {fhirKeys} from './query_keys';

// reference: REQUIREMENTS.md FR-CARD-1, FR-CARD-3, FR-CARD-5, FR-AUTH-5, NFR-PERF-3 · INTERFACES.md API-44

const OTHER_PATIENT_ID = 'test-patient-0002';

interface QueryView {
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly data: readonly {readonly kind: string}[] | undefined;
}

/** Renders a query the way a card will: loading, a failure kind, or one row per item. */
function QueryState(props: {
  label: string;
  query: QueryView;
  text: (index: number) => string;
}): ReactNode {
  const {label, query, text} = props;
  if (query.isPending) return <p>{label}: loading</p>;
  if (query.error !== null) {
    const kind =
      query.error instanceof ApiError ? query.error.failure.kind : 'unexpected';
    return <p role="alert">{`${label}: ${kind}`}</p>;
  }
  return (
    <ul aria-label={label}>
      {query.data?.map((item, i) => (
        <li key={i}>
          {item.kind === 'ok' ? text(i) : 'Could not display this item'}
        </li>
      ))}
    </ul>
  );
}

function AllergiesProbe(props: {patientId: string}): ReactNode {
  const query = useAllergies(props.patientId);
  return (
    <QueryState
      label={`Allergies ${props.patientId}`}
      query={query}
      text={i => {
        const item = query.data?.[i];
        return item?.kind === 'ok' ? (item.resource.code?.text ?? '') : '';
      }}
    />
  );
}

function ProblemsProbe(props: {patientId: string}): ReactNode {
  const query = useProblems(props.patientId);
  return (
    <QueryState
      label={`Problems ${props.patientId}`}
      query={query}
      text={i => {
        const item = query.data?.[i];
        return item?.kind === 'ok' ? (item.resource.code?.text ?? '') : '';
      }}
    />
  );
}

function PatientProbe(props: {patientId: string}): ReactNode {
  const query = usePatient(props.patientId);
  if (query.isPending) return <p>Patient: loading</p>;
  if (query.isError) return <p role="alert">Patient: failed</p>;
  return <p>{`Patient: ${query.data.kind}`}</p>;
}

function PractitionerProbe(props: {id: string}): ReactNode {
  const query = usePractitioner(props.id);
  if (query.isPending) return <p>Practitioner: loading</p>;
  if (query.isError) return <p role="alert">Practitioner: failed</p>;
  const item = query.data;
  return (
    <p>
      {item.kind === 'ok'
        ? `Practitioner: ${item.resource.name?.[0]?.family ?? ''}`
        : 'Practitioner: could not display'}
    </p>
  );
}

/** A card that gates its own query, e.g. until it is expanded. */
function GatedAllergies(props: {
  patientId: string;
  enabled: boolean;
}): ReactNode {
  const query = useAllergies(props.patientId, {enabled: props.enabled});
  if (query.isSuccess) return <p>Allergies: loaded</p>;
  return <p>{query.isError ? 'Allergies: stopped' : 'Allergies: waiting'}</p>;
}

/** A card that builds its query from the exported options instead of the hook. */
function DirectAllergies(props: {patientId: string}): ReactNode {
  const query = useQuery({...allergiesQuery(props.patientId), enabled: true});
  return <p>{query.isSuccess ? 'Direct: loaded' : 'Direct: waiting'}</p>;
}

/** A card with a manual refresh control, as FR-CARD-5's refresh button will be. */
function RefreshableAllergies(props: {patientId: string}): ReactNode {
  const query = useAllergies(props.patientId);
  return (
    <button type="button" onClick={() => void query.refetch()}>
      Refresh
    </button>
  );
}

function renderWith(client: QueryClient, ui: ReactNode) {
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  const view = render(wrap(ui));
  return {
    rerender: (node: ReactNode) => {
      view.rerender(wrap(node));
    },
  };
}

/** Lets any fetch a test is guarding against start and finish. */
async function settle(): Promise<void> {
  await act(() => new Promise(resolve => setTimeout(resolve, 50)));
}

/** Counts requests to one FHIR path; `bodies` answer in turn, the last one repeating. */
function answer(
  path: string,
  ...responses: readonly (() => Response)[]
): {count: () => number} {
  let calls = 0;
  server.use(
    http.get(`/bff/fhir/${path}`, () => {
      const respond = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (respond === undefined) throw new Error('no response configured');
      return respond();
    }),
  );
  return {count: () => calls};
}

function newClient(onSessionOver = vi.fn()): QueryClient {
  return createQueryClient({onSessionOver, retryDelayMs: 0});
}

describe('given a card query for a patient', () => {
  it('when the search succeeds with one malformed entry, then every item renders, the bad one as "could not display" (FR-CARD-3)', async () => {
    answer('AllergyIntolerance', () =>
      HttpResponse.json(
        searchBundle([
          allergy({code: {text: 'Test substance A'}}),
          allergy({criticality: 'not-a-criticality'}),
        ]),
      ),
    );
    renderWith(newClient(), <AllergiesProbe patientId={TEST_PATIENT_ID} />);

    expect(
      screen.getByText(`Allergies ${TEST_PATIENT_ID}: loading`),
    ).toBeInTheDocument();
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map(r => r.textContent)).toEqual([
      'Test substance A',
      'Could not display this item',
    ]);
  });

  it('when the server answers 403, then the card shows not-authorised and does not retry (FR-AUTH-5)', async () => {
    const allergies = answer('AllergyIntolerance', () =>
      HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
    );
    renderWith(newClient(), <AllergiesProbe patientId={TEST_PATIENT_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'not-authorised',
    );
    expect(allergies.count()).toBe(1);
  });

  it('when one card fails, then another card for the same patient still loads (FR-CARD-1)', async () => {
    answer('AllergyIntolerance', () =>
      HttpResponse.json(operationOutcome('exception'), {status: 500}),
    );
    answer('Condition', () =>
      HttpResponse.json(
        searchBundle([condition({code: {text: 'Test problem A'}})]),
      ),
    );
    renderWith(
      newClient(),
      <>
        <AllergiesProbe patientId={TEST_PATIENT_ID} />
        <ProblemsProbe patientId={TEST_PATIENT_ID} />
      </>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('server-error');
    expect(await screen.findByText('Test problem A')).toBeInTheDocument();
  });

  it('when the server fails once with 503, then the query retries once and shows the data', async () => {
    const allergies = answer(
      'AllergyIntolerance',
      () => HttpResponse.json(operationOutcome('transient'), {status: 503}),
      () => HttpResponse.json(searchBundle([allergy()])),
    );
    renderWith(newClient(), <AllergiesProbe patientId={TEST_PATIENT_ID} />);

    expect(await screen.findByText('Test substance A')).toBeInTheDocument();
    expect(allergies.count()).toBe(2);
  });

  it('when the network keeps failing, then the query gives up after one retry and shows a network error', async () => {
    const allergies = answer('AllergyIntolerance', () => HttpResponse.error());
    renderWith(newClient(), <AllergiesProbe patientId={TEST_PATIENT_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('network-error');
    expect(allergies.count()).toBe(2);
  });

  it('when a response is malformed, then the query does not retry it', async () => {
    const allergies = answer('AllergyIntolerance', () =>
      HttpResponse.html('<html>not FHIR</html>'),
    );
    renderWith(newClient(), <AllergiesProbe patientId={TEST_PATIENT_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'malformed-response',
    );
    expect(allergies.count()).toBe(1);
  });
});

describe('given the session ends while the dashboard is open', () => {
  it('when any read answers 401, then the session-over handler runs once and cached patient data is cleared (FR-AUTH-5)', async () => {
    answer(`Patient/${TEST_PATIENT_ID}`, () => HttpResponse.json(patient()));
    answer('AllergyIntolerance', () =>
      HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
    );
    const onSessionOver = vi.fn();
    const client = newClient(onSessionOver);

    renderWith(client, <PatientProbe patientId={TEST_PATIENT_ID} />);
    expect(await screen.findByText('Patient: ok')).toBeInTheDocument();
    expect(
      client.getQueryData(fhirKeys.patientRecord(TEST_PATIENT_ID)),
    ).toBeDefined();

    renderWith(client, <AllergiesProbe patientId={TEST_PATIENT_ID} />);
    await waitFor(() => {
      expect(onSessionOver).toHaveBeenCalledTimes(1);
    });
    expect(
      client.getQueryData(fhirKeys.patientRecord(TEST_PATIENT_ID)),
    ).toBeUndefined();
  });

  it('when the session is over, then no re-render, invalidation or refresh reaches the server again (FR-AUTH-5)', async () => {
    const allergies = answer('AllergyIntolerance', () =>
      HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
    );
    const onSessionOver = vi.fn();
    const client = newClient(onSessionOver);
    const view = renderWith(
      client,
      <RefreshableAllergies patientId={TEST_PATIENT_ID} />,
    );
    await waitFor(() => {
      expect(onSessionOver).toHaveBeenCalledTimes(1);
    });
    await settle();
    expect(allergies.count()).toBe(1);

    view.rerender(<RefreshableAllergies patientId={TEST_PATIENT_ID} />);
    await settle();
    await act(() => client.invalidateQueries());
    await act(() => client.refetchQueries());
    await userEvent.click(screen.getByRole('button', {name: 'Refresh'}));
    await settle();

    expect(allergies.count()).toBe(1);
    expect(onSessionOver).toHaveBeenCalledTimes(1);
  });
});

describe('given a card that passes its own enabled flag', () => {
  it('when it is disabled, then nothing is fetched until it is enabled', async () => {
    const allergies = answer('AllergyIntolerance', () =>
      HttpResponse.json(searchBundle([allergy()])),
    );
    const view = renderWith(
      newClient(),
      <GatedAllergies patientId={TEST_PATIENT_ID} enabled={false} />,
    );
    await settle();
    expect(screen.getByText('Allergies: waiting')).toBeInTheDocument();
    expect(allergies.count()).toBe(0);

    view.rerender(<GatedAllergies patientId={TEST_PATIENT_ID} enabled />);
    expect(await screen.findByText('Allergies: loaded')).toBeInTheDocument();
    expect(allergies.count()).toBe(1);
  });

  it('when the session is over, then enabled: true cannot switch the stop off and the hook stays idle, through the hook or the options (FR-AUTH-5)', async () => {
    answer(`Patient/${TEST_PATIENT_ID}`, () =>
      HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
    );
    const allergies = answer('AllergyIntolerance', () =>
      HttpResponse.json(searchBundle([allergy()])),
    );
    const onSessionOver = vi.fn();
    const client = newClient(onSessionOver);
    const view = renderWith(
      client,
      <PatientProbe patientId={TEST_PATIENT_ID} />,
    );
    await waitFor(() => {
      expect(onSessionOver).toHaveBeenCalledTimes(1);
    });

    view.rerender(<GatedAllergies patientId={TEST_PATIENT_ID} enabled />);
    await settle();
    expect(allergies.count()).toBe(0);
    expect(screen.getByText('Allergies: waiting')).toBeInTheDocument();

    view.rerender(<DirectAllergies patientId={TEST_PATIENT_ID} />);
    await settle();
    expect(allergies.count()).toBe(0);
    expect(screen.getByText('Direct: waiting')).toBeInTheDocument();
  });
});

describe('given the query key factory', () => {
  it('when one patient is refreshed, then every card of that patient refetches and no other patient does (FR-CARD-5)', async () => {
    let version = 0;
    const allergies = answer('AllergyIntolerance', () =>
      HttpResponse.json(
        searchBundle([
          allergy({code: {text: `Test substance v${String(version)}`}}),
        ]),
      ),
    );
    const problems = answer('Condition', () =>
      HttpResponse.json(searchBundle([condition()])),
    );
    const client = newClient();
    renderWith(
      client,
      <>
        <AllergiesProbe patientId={TEST_PATIENT_ID} />
        <ProblemsProbe patientId={TEST_PATIENT_ID} />
        <AllergiesProbe patientId={OTHER_PATIENT_ID} />
      </>,
    );
    await waitFor(() => {
      expect(screen.getAllByText('Test substance v0')).toHaveLength(2);
    });
    expect(await screen.findByText('Test problem A')).toBeInTheDocument();
    const before = {allergies: allergies.count(), problems: problems.count()};

    version = 1;
    await act(() =>
      client.invalidateQueries({queryKey: fhirKeys.patient(TEST_PATIENT_ID)}),
    );

    expect(await screen.findByText('Test substance v1')).toBeInTheDocument();
    expect(screen.getByText('Test substance v0')).toBeInTheDocument();
    expect(allergies.count()).toBe(before.allergies + 1);
    expect(problems.count()).toBe(before.problems + 1);
  });

  it('when two cards need the same practitioner, then it is fetched once (NFR-PERF-3)', async () => {
    const reads = answer('Practitioner/test-practitioner-0001', () =>
      HttpResponse.json(practitioner()),
    );
    renderWith(
      newClient(),
      <>
        <PractitionerProbe id="test-practitioner-0001" />
        <PractitionerProbe id="test-practitioner-0001" />
      </>,
    );

    expect(await screen.findAllByText('Practitioner: Testdoctor')).toHaveLength(
      2,
    );
    expect(reads.count()).toBe(1);
  });
});
