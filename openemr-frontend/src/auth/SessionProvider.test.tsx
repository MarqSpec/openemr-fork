import {useQueryClient} from '@tanstack/react-query';
import {act, fireEvent, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {usePatient} from '../api/fhir/hooks';
import {patient, TEST_PATIENT_ID} from '../test/fhir_fixtures';
import {server} from '../test/msw_server';
import {SessionProvider, useSession} from './SessionProvider';

// reference: REQUIREMENTS.md FR-AUTH-3, FR-AUTH-5, FR-UI-3 · INTERFACES.md API-42 · a separate change (note 85517),
// a separate change (note 87776: bfcache), a separate change (note 87130)

const SESSION_URL = '/bff/session';
const PATIENT_URL = `/bff/fhir/Patient/${TEST_PATIENT_ID}`;
/** A synthetic patient name that must be gone from the DOM once the session is over. */
const PATIENT_FAMILY = 'Zzphi-Testperson';

function signedIn(displayName: string | null = 'Dr. Avery Demo') {
  return {
    authenticated: true,
    user: {displayName},
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    idleTimeoutSeconds: 900,
    grantedScopes: ['openid', 'fhirUser'],
  };
}

/** Counts every /bff/session request and answers with the given responder. */
function sessionHandler(respond: () => Response) {
  const counter = {count: 0};
  server.use(
    http.get(SESSION_URL, () => {
      counter.count += 1;
      return respond();
    }),
  );
  return counter;
}

/** Stands in for a patient view: renders PHI from a FHIR read and can refresh it, as a card will. */
function PatientProbe(): ReactNode {
  const query = usePatient(TEST_PATIENT_ID);
  const item = query.data;
  return (
    <section aria-label="Chart">
      {item?.kind === 'ok' && <h2>{item.resource.name?.[0]?.family}</h2>}
      <button type="button" onClick={() => void query.refetch()}>
        Refresh chart
      </button>
    </section>
  );
}

function CacheSize(): ReactNode {
  const client = useQueryClient();
  return (
    <p>{`Cached queries: ${String(client.getQueryCache().getAll().length)}`}</p>
  );
}

function Probe(): ReactNode {
  const session = useSession();
  switch (session.kind) {
    case 'checking':
      return <p>checking</p>;
    case 'signed-in':
      return (
        <>
          <p>{`signed in as ${session.displayName ?? '(no name)'}`}</p>
          <PatientProbe />
        </>
      );
    case 'signed-out':
      return (
        <>
          <p>{session.ended ? 'session ended' : 'not signed in'}</p>
          <CacheSize />
        </>
      );
    case 'offline':
      return (
        <>
          <p>offline</p>
          <button type="button" onClick={session.retry}>
            Retry
          </button>
        </>
      );
    case 'unavailable':
      return (
        <>
          <p>session unknown</p>
          <button type="button" onClick={session.retry}>
            Retry
          </button>
        </>
      );
  }
}

function renderProbe(reload: () => void = () => undefined) {
  return render(
    <SessionProvider reload={reload}>
      <Probe />
    </SessionProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('given the app starts', () => {
  it('when the session read is still out, then the state is checking', () => {
    sessionHandler(() => HttpResponse.json(signedIn()));
    renderProbe();

    expect(screen.getByText('checking')).toBeInTheDocument();
  });

  it('when /bff/session answers 200, then the clinician is signed in under their display name', async () => {
    sessionHandler(() => HttpResponse.json(signedIn()));
    renderProbe();

    expect(
      await screen.findByText('signed in as Dr. Avery Demo'),
    ).toBeInTheDocument();
  });

  it('when OpenEMR gave no display name, then the clinician is still signed in', async () => {
    sessionHandler(() => HttpResponse.json(signedIn(null)));
    renderProbe();

    expect(
      await screen.findByText('signed in as (no name)'),
    ).toBeInTheDocument();
  });

  it('when /bff/session answers 401, then nobody is signed in, and that is not reported as a session that ended', async () => {
    sessionHandler(() =>
      HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
    );
    renderProbe();

    expect(await screen.findByText('not signed in')).toBeInTheDocument();
  });

  it('when /bff/session fails with a 503, then the state is unknown and it is not retried behind the user’s back', async () => {
    const reads = sessionHandler(() => new HttpResponse(null, {status: 503}));
    renderProbe();

    expect(await screen.findByText('session unknown')).toBeInTheDocument();
    expect(reads.count).toBe(1);
  });

  it('when the user retries after a failure and the token handler answers, then they are signed in', async () => {
    let fail = true;
    const reads = sessionHandler(() =>
      fail
        ? new HttpResponse(null, {status: 503})
        : HttpResponse.json(signedIn()),
    );
    renderProbe();
    await screen.findByText('session unknown');

    fail = false;
    await userEvent.click(screen.getByRole('button', {name: 'Retry'}));

    expect(
      await screen.findByText('signed in as Dr. Avery Demo'),
    ).toBeInTheDocument();
    expect(reads.count).toBe(2);
  });
});

describe('given the tablet has no connection (FR-PWA-4)', () => {
  it('when the session read never gets an answer, then the state is offline, not "unknown"', async () => {
    const reads = sessionHandler(() => HttpResponse.error());
    renderProbe();

    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(reads.count).toBe(1);
  });

  it('when the connection comes back and the session is still live, then the clinician resumes signed in without tapping anything', async () => {
    let connected = false;
    const reads = sessionHandler(() =>
      connected ? HttpResponse.json(signedIn()) : HttpResponse.error(),
    );
    renderProbe();
    await screen.findByText('offline');

    connected = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(
      await screen.findByText('signed in as Dr. Avery Demo'),
    ).toBeInTheDocument();
    expect(reads.count).toBe(2);
  });

  it('when the connection comes back after the session ended, then sign-in is shown (re-auth)', async () => {
    let connected = false;
    sessionHandler(() =>
      connected
        ? HttpResponse.json({error: 'unauthenticated'}, {status: 401})
        : HttpResponse.error(),
    );
    renderProbe();
    await screen.findByText('offline');

    connected = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(
      await screen.findByText(/not signed in|session ended/),
    ).toBeInTheDocument();
  });

  it('when the clinician taps Retry while still offline, then it stays offline', async () => {
    const reads = sessionHandler(() => HttpResponse.error());
    renderProbe();
    await screen.findByText('offline');

    await userEvent.click(screen.getByRole('button', {name: 'Retry'}));

    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(reads.count).toBe(2);
  });
});

describe('given a signed-in clinician with a chart on screen', () => {
  async function renderChart() {
    sessionHandler(() => HttpResponse.json(signedIn()));
    let patientStatus = 200;
    server.use(
      http.get(PATIENT_URL, () =>
        patientStatus === 200
          ? HttpResponse.json(
              patient({name: [{family: PATIENT_FAMILY, given: ['Fakey']}]}),
            )
          : HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
      ),
    );
    renderProbe();
    expect(
      await screen.findByRole('heading', {name: PATIENT_FAMILY}),
    ).toBeInTheDocument();
    return {
      expireSession: () => {
        patientStatus = 401;
      },
    };
  }

  it('when any read answers 401, then the chart unmounts: no patient data is left in the DOM (FR-AUTH-5)', async () => {
    const {expireSession} = await renderChart();

    expireSession();
    await userEvent.click(screen.getByRole('button', {name: 'Refresh chart'}));

    expect(await screen.findByText('session ended')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
    expect(
      screen.queryByRole('region', {name: 'Chart'}),
    ).not.toBeInTheDocument();
  });

  it('when any read answers 401, then every cached query is dropped, the session read included', async () => {
    const {expireSession} = await renderChart();

    expireSession();
    await userEvent.click(screen.getByRole('button', {name: 'Refresh chart'}));

    expect(await screen.findByText('Cached queries: 0')).toBeInTheDocument();
  });
});

describe('given a signed-in chart and the back/forward cache', () => {
  async function renderChartWith(reload: () => void) {
    sessionHandler(() => HttpResponse.json(signedIn()));
    server.use(
      http.get(PATIENT_URL, () =>
        HttpResponse.json(
          patient({name: [{family: PATIENT_FAMILY, given: ['Fakey']}]}),
        ),
      ),
    );
    renderProbe(reload);
    await screen.findByRole('heading', {name: PATIENT_FAMILY});
  }

  it('when the page is hidden to be cached (pagehide), then the chart unmounts and every cached query is dropped before the snapshot is taken', async () => {
    const reload = vi.fn();
    await renderChartWith(reload);

    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', {persisted: true}),
      );
    });

    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
    expect(screen.getByText('Cached queries: 0')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('when the page is restored from the back/forward cache (pageshow, persisted), then it reloads, so the session is read again rather than trusted', async () => {
    const reload = vi.fn();
    await renderChartWith(reload);

    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', {persisted: true}),
      );
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', {persisted: true}),
      );
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });

  it('when the page is shown by an ordinary load (pageshow, not persisted), then it does not reload', async () => {
    const reload = vi.fn();
    await renderChartWith(reload);

    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', {persisted: false}),
      );
    });

    expect(reload).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', {name: PATIENT_FAMILY}),
    ).toBeInTheDocument();
  });
});

describe('given a signed-in clinician who leaves the tablet alone', () => {
  it('when 30 minutes pass and the window regains focus or comes back online, then nothing is read in the background: one patient read, no keep-alive, and exactly one extra session read (the idle warning, which is not activity) before the timeout signs out', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true});
    const reads = sessionHandler(() => HttpResponse.json(signedIn()));
    const patientReads = {count: 0};
    const keepAlives = {count: 0};
    server.use(
      http.get(PATIENT_URL, () => {
        patientReads.count += 1;
        return HttpResponse.json(patient());
      }),
      http.post('/bff/session/activity', () => {
        keepAlives.count += 1;
        return HttpResponse.json({expiresAt: new Date().toISOString()});
      }),
    );
    const signOut = vi.fn();
    render(
      <SessionProvider signOut={signOut}>
        <Probe />
      </SessionProvider>,
    );
    await screen.findByText('signed in as Dr. Avery Demo');

    await act(async () => {
      fireEvent.focus(window);
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 5000);
    });
    // The warning's re-read is answered on real I/O; let it land before time moves on.
    await screen.findByRole('alertdialog', {name: 'Still there?'});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    });

    expect(reads.count).toBe(2);
    expect(patientReads.count).toBe(1);
    expect(keepAlives.count).toBe(0);
    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
  });
});
