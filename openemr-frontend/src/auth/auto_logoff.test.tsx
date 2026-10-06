import {useQueryClient} from '@tanstack/react-query';
import {act, fireEvent, render, screen} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {usePatient} from '../api/fhir/hooks';
import {patient, TEST_PATIENT_ID} from '../test/fhir_fixtures';
import {server} from '../test/msw_server';
import {SessionProvider, useSession} from './SessionProvider';

// Automatic logoff (W-6) and the privacy screen (W-7), on fake timers.
// reference: REQUIREMENTS.md FR-AUTH-4, FR-UI-4, NFR-SEC-3 · INTERFACES.md API-42, API-44, API-46 ·
// REQUIREMENTS.md W-6, W-7 · a separate change (note 87130), a separate change

const SESSION_URL = '/bff/session';
const ACTIVITY_URL = '/bff/session/activity';
const PATIENT_URL = `/bff/fhir/Patient/${TEST_PATIENT_ID}`;
const PATIENT_FAMILY = 'Zzphi-Testperson';
const MINUTE = 60 * 1000;
const IDLE_SECONDS = 15 * 60;

/** API-42 for a session that ends at `expiresAt` (epoch ms), with the server clock sent as `Date`. */
function sessionAnswer(expiresAt: number) {
  const now = Date.now();
  return HttpResponse.json(
    {
      authenticated: true,
      user: {displayName: 'Dr. Avery Demo'},
      expiresAt: new Date(expiresAt).toISOString(),
      idleTimeoutSeconds: IDLE_SECONDS,
      grantedScopes: ['openid', 'fhirUser'],
    },
    {headers: {Date: new Date(now).toUTCString()}},
  );
}

interface Backend {
  sessionReads: number;
  patientReads: number;
  keepAlives: number;
  /** When the server session ends (epoch ms), as the next /bff/session read reports it; `null` answers 401. */
  expiresAt: number | null;
  keepAliveStatus: number;
  /** A 200 keep-alive whose body is not the expiry shape. */
  keepAliveMalformed: boolean;
  /** When set, the keep-alive answers this expiry instead of a full idle period (e.g. the 10 h maximum). */
  keepAliveExpiresAt: number | null;
  /** A session read that gets no answer: `server` a 503, `network` no HTTP answer at all. */
  sessionFailure: 'none' | 'server' | 'network' | 'never-answers';
  /** The keep-alive (API-46) is sent but never answered: a stalled connection. */
  keepAliveHangs: boolean;
  /** The keep-alive gets no HTTP answer at all: the tablet is offline or the connection drops. */
  keepAliveNetworkError: boolean;
}

/** A response that never comes; the request ends only if the client aborts it. */
function neverAnswer(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

function backend(): Backend {
  const state: Backend = {
    sessionReads: 0,
    patientReads: 0,
    keepAlives: 0,
    expiresAt: Date.now() + IDLE_SECONDS * 1000,
    keepAliveStatus: 200,
    keepAliveMalformed: false,
    keepAliveExpiresAt: null,
    sessionFailure: 'none',
    keepAliveHangs: false,
    keepAliveNetworkError: false,
  };
  server.use(
    http.get(SESSION_URL, () => {
      state.sessionReads += 1;
      if (state.sessionFailure === 'server') {
        return new HttpResponse(null, {status: 503});
      }
      if (state.sessionFailure === 'network') return HttpResponse.error();
      if (state.sessionFailure === 'never-answers') return neverAnswer();
      return state.expiresAt === null
        ? HttpResponse.json({error: 'unauthenticated'}, {status: 401})
        : sessionAnswer(state.expiresAt);
    }),
    http.get(PATIENT_URL, () => {
      state.patientReads += 1;
      return HttpResponse.json(
        patient({name: [{family: PATIENT_FAMILY, given: ['Fakey']}]}),
      );
    }),
    http.post(ACTIVITY_URL, () => {
      state.keepAlives += 1;
      if (state.keepAliveHangs) return neverAnswer();
      if (state.keepAliveNetworkError) return HttpResponse.error();
      if (state.keepAliveStatus !== 200) {
        return HttpResponse.json({error: 'x'}, {status: state.keepAliveStatus});
      }
      if (state.keepAliveMalformed) return HttpResponse.json({ok: true});
      // The server's idle clock restarts (up to the maximum), and the answer says where it now ends.
      state.expiresAt =
        state.keepAliveExpiresAt ?? Date.now() + IDLE_SECONDS * 1000;
      return HttpResponse.json(
        {expiresAt: new Date(state.expiresAt).toISOString()},
        {headers: {Date: new Date().toUTCString()}},
      );
    }),
  );
  return state;
}

function Chart(): ReactNode {
  const query = usePatient(TEST_PATIENT_ID);
  const item = query.data;
  return (
    <section aria-label="Chart">
      {item?.kind === 'ok' && <h2>{item.resource.name?.[0]?.family}</h2>}
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
  if (session.kind === 'signed-in') return <Chart />;
  if (session.kind === 'signed-out') {
    return (
      <>
        <p>{session.ended ? 'session ended' : 'not signed in'}</p>
        <CacheSize />
      </>
    );
  }
  return <p>{session.kind}</p>;
}

async function renderSignedIn(state: Backend) {
  const signOut = vi.fn();
  render(
    <SessionProvider signOut={signOut} privacyGraceSeconds={60}>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByRole('heading', {name: PATIENT_FAMILY});
  expect(state.sessionReads).toBe(1);
  return {signOut};
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const warning = () => screen.queryByRole('alertdialog', {name: 'Still there?'});

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('given a signed-in clinician who stops using the tablet (W-6)', () => {
  it('when 14 minutes pass, then a modal "Still there?" alertdialog warns of sign-out in 1:00, with "Stay signed in" focused (guards a silent logoff and a one-tap sign-out)', async () => {
    const state = backend();
    await renderSignedIn(state);

    await advance(13 * MINUTE + 50_000);
    expect(warning()).not.toBeInTheDocument();

    await advance(15_000);
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Still there?',
    });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(/signed out in 1 minute/);
    expect(screen.getByRole('button', {name: 'Stay signed in'})).toHaveFocus();
    expect(screen.getByRole('button', {name: 'Sign out now'})).toBeVisible();
    expect(dialog).toHaveTextContent(/0:5\d|1:00/);
  });

  it('when the warning counts down, then the visible time ticks each second but a screen reader hears it only at 30 and 10 seconds (guards a live region that chatters every second)', async () => {
    const state = backend();
    await renderSignedIn(state);
    await advance(14 * MINUTE + 1000);
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Still there?',
    });
    const announcer = screen.getByRole('status');

    await advance(12_000);
    expect(dialog).toHaveTextContent(/0:4[6-8]/);
    expect(announcer).toHaveTextContent('');

    await advance(17_000);
    expect(announcer).toHaveTextContent('30 seconds left');

    await advance(20_000);
    expect(announcer).toHaveTextContent('10 seconds left');
  });

  it('when no one answers the warning, then at 15 minutes the app signs out through the sign-out form post, clearing patient data and every cached query first', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);

    await advance(14 * MINUTE + 5000);
    await screen.findByRole('alertdialog', {name: 'Still there?'});
    expect(signOut).not.toHaveBeenCalled();

    await advance(60_000);

    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
    expect(screen.getByText('session ended')).toBeInTheDocument();
    expect(screen.getByText('Cached queries: 0')).toBeInTheDocument();
  });

  it('when "Sign out now" is chosen, then it signs out at once', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);
    await advance(14 * MINUTE + 5000);
    await screen.findByRole('alertdialog', {name: 'Still there?'});

    fireEvent.click(screen.getByRole('button', {name: 'Sign out now'}));

    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });

  it('when the clinician is idle, then no patient read and no session read is sent in the background (note 87130: a background read would keep an unattended tablet signed in)', async () => {
    const state = backend();
    await renderSignedIn(state);

    await act(async () => {
      fireEvent.focus(window);
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(13 * MINUTE);
    });

    expect(state.patientReads).toBe(1);
    expect(state.sessionReads).toBe(1);
    expect(state.keepAlives).toBe(0);
  });
});

describe('given the warning is showing (extend)', () => {
  async function warned() {
    const state = backend();
    const rendered = await renderSignedIn(state);
    await advance(14 * MINUTE + 5000);
    await screen.findByRole('alertdialog', {name: 'Still there?'});
    return {state, ...rendered};
  }

  it('when "Stay signed in" is chosen, then one keep-alive restarts the server idle clock and its answer is the new deadline (no session re-read), the warning closes and no sign-out follows at 15 minutes', async () => {
    const {state, signOut} = await warned();
    const readsBefore = state.sessionReads;

    fireEvent.click(screen.getByRole('button', {name: 'Stay signed in'}));
    await advance(1000);

    expect(state.keepAlives).toBe(1);
    expect(state.sessionReads).toBe(readsBefore);
    expect(warning()).not.toBeInTheDocument();

    await advance(5 * MINUTE);
    expect(signOut).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', {name: PATIENT_FAMILY}),
    ).toBeInTheDocument();
  });

  it('when Escape is pressed, then it is "Stay signed in", never a sign-out (Escape is the safe action, as in W-12c)', async () => {
    const {state, signOut} = await warned();

    fireEvent.keyDown(screen.getByRole('alertdialog'), {key: 'Escape'});
    await advance(1000);

    expect(state.keepAlives).toBe(1);
    expect(warning()).not.toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('when the clinician touches, types or scrolls behind the warning, then it stays open: only an explicit choice restarts the server clock', async () => {
    const {state} = await warned();

    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, {key: 'a'});
    fireEvent.scroll(window);
    await advance(1000);

    expect(warning()).toBeInTheDocument();
    expect(state.keepAlives).toBe(0);
  });

  it('when "Stay signed in" finds the session already over (401), then patient data is cleared and sign-in shows the session ended', async () => {
    const {state} = await warned();
    state.keepAliveStatus = 401;

    fireEvent.click(screen.getByRole('button', {name: 'Stay signed in'}));
    await advance(1000);

    expect(await screen.findByText('session ended')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });

  it('when "Stay signed in" cannot reach the server (503), then the warning stays with an error and the countdown still ends in sign-out', async () => {
    const {state, signOut} = await warned();
    state.keepAliveStatus = 503;

    fireEvent.click(screen.getByRole('button', {name: 'Stay signed in'}));
    await advance(1000);

    expect(warning()).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /couldn.t keep you signed in/i,
    );

    await advance(60_000);
    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
  });

  it('when "Stay signed in" gets no answer at all (a network error: offline or a dropped connection), then the warning stays with an error, the chart is not replaced, and the countdown still ends in sign-out (guards a failed keep-alive read as extended or as session over)', async () => {
    const {state, signOut} = await warned();
    state.keepAliveNetworkError = true;

    fireEvent.click(screen.getByRole('button', {name: 'Stay signed in'}));
    await advance(1000);

    expect(state.keepAlives).toBe(1);
    expect(warning()).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /couldn.t keep you signed in/i,
    );
    expect(screen.queryByText('session ended')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {name: PATIENT_FAMILY, hidden: true}),
    ).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();

    await advance(60_000);
    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
  });

  it('when "Stay signed in" is answered 200 but without the expiry (malformed), then the warning stays with an error, the chart is not replaced, and the countdown still ends in sign-out (guards an odd answer counting as extended)', async () => {
    const {state, signOut} = await warned();
    state.keepAliveMalformed = true;

    fireEvent.click(screen.getByRole('button', {name: 'Stay signed in'}));
    await advance(1000);

    expect(state.keepAlives).toBe(1);
    expect(warning()).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /couldn.t keep you signed in/i,
    );
    expect(screen.queryByText('unavailable')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {name: PATIENT_FAMILY, hidden: true}),
    ).toBeInTheDocument();

    await advance(60_000);
    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
  });

  it('when "Stay signed in" is answered with an expiry under a minute away (the 10 h maximum, PRD Q-2), then the warning stays and says the session cannot be extended, and it still signs out', async () => {
    const {state, signOut} = await warned();
    state.keepAliveExpiresAt = Date.now() + 30_000;

    fireEvent.click(screen.getByRole('button', {name: 'Stay signed in'}));
    await advance(1000);

    expect(state.keepAlives).toBe(1);
    expect(warning()).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/time limit/i);

    await advance(60_000);
    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
  });
});

describe('given the session re-read at warning time fails without an answer', () => {
  it.each(['server', 'network'] as const)(
    'when it is a %s failure (a 503, or no answer), then the warning still shows on the last known deadline, the chart is not swapped for sign-in, and the timeout still signs out (review of !129)',
    async failure => {
      const state = backend();
      const {signOut} = await renderSignedIn(state);
      state.sessionFailure = failure;

      await advance(14 * MINUTE + 5000);

      expect(
        await screen.findByRole('alertdialog', {name: 'Still there?'}),
      ).toBeInTheDocument();
      expect(screen.queryByText('unavailable')).not.toBeInTheDocument();
      expect(
        screen.getByRole('heading', {name: PATIENT_FAMILY, hidden: true}),
      ).toBeInTheDocument();

      await advance(60_000);
      expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
      expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
    },
  );

  it('when the app is hidden meanwhile, then the privacy cover still goes up and the app signs out once the grace passes (the privacy hook is not dropped by a failed re-read)', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);
    state.sessionFailure = 'server';
    await advance(14 * MINUTE + 5000);
    await screen.findByRole('alertdialog', {name: 'Still there?'});

    setVisibility('hidden');
    expect(screen.getByText('Patient data hidden')).toBeVisible();

    await advance(61_000);
    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });
});

describe('given a request on the watch path never answers (a stalled connection, review of !129 round 2)', () => {
  it('when the automatic keep-alive after a tap never answers, then the warning still opens with the error and the app signs out by the last known deadline (guards sign-out waiting on the network)', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);
    state.keepAliveHangs = true;

    await advance(10 * MINUTE);
    fireEvent.pointerDown(document.body);
    await advance(4 * MINUTE + 15_000);

    expect(state.keepAlives).toBe(1);
    expect(
      await screen.findByRole('alertdialog', {name: 'Still there?'}),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /couldn.t keep you signed in/i,
    );

    await advance(60_000);
    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });

  it('when the session re-read at warning time never answers and there was no input, then the warning still opens and the app signs out by the last known deadline', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);
    state.sessionFailure = 'never-answers';

    await advance(14 * MINUTE + 15_000);

    expect(
      await screen.findByRole('alertdialog', {name: 'Still there?'}),
    ).toBeInTheDocument();

    await advance(60_000);
    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });
});

describe('given the clinician is using the tablet but the chart makes no server request (FR-AUTH-4: touch, key and scroll are activity)', () => {
  it('when they touched and scrolled within the idle period, then at the warning time one authenticated request is sent automatically instead of the warning, and they stay signed in', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);

    await advance(10 * MINUTE);
    fireEvent.pointerDown(document.body);
    fireEvent.scroll(window);
    await advance(4 * MINUTE + 5000);

    expect(warning()).not.toBeInTheDocument();
    expect(state.keepAlives).toBe(1);

    await advance(5 * MINUTE);
    expect(signOut).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', {name: PATIENT_FAMILY}),
    ).toBeInTheDocument();
  });

  it('when there is no further input after the automatic request, then the warning comes one idle period after the last touch: at most one automatic request per input (guards note 87130: an unattended tablet must still time out)', async () => {
    const state = backend();
    await renderSignedIn(state);

    await advance(10 * MINUTE);
    fireEvent.keyDown(document.body, {key: 'Tab'});
    await advance(4 * MINUTE + 5000);
    expect(state.keepAlives).toBe(1);

    // Last input at 10:00: idle deadline 25:00, so the warning is due at 24:00.
    await advance(9 * MINUTE + 45_000);
    expect(warning()).not.toBeInTheDocument();

    await advance(30_000);
    expect(
      await screen.findByRole('alertdialog', {name: 'Still there?'}),
    ).toBeInTheDocument();
    expect(state.keepAlives).toBe(1);
  });

  it('when the automatic request cannot reach the server (503), then the warning shows with the error rather than silently failing', async () => {
    const state = backend();
    await renderSignedIn(state);
    state.keepAliveStatus = 503;

    await advance(10 * MINUTE);
    fireEvent.pointerDown(document.body);
    await advance(4 * MINUTE + 5000);

    expect(
      await screen.findByRole('alertdialog', {name: 'Still there?'}),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /couldn.t keep you signed in/i,
    );
  });
});

describe('given the client and server idle clocks disagree', () => {
  it('when the server reports a later expiry at warning time (other requests counted as activity), then no warning shows and no extra request is sent', async () => {
    const state = backend();
    await renderSignedIn(state);

    await advance(10 * MINUTE);
    fireEvent.keyDown(document.body, {key: 'Tab'});
    state.expiresAt = Date.now() + 10 * MINUTE;
    await advance(4 * MINUTE + 5000);

    expect(warning()).not.toBeInTheDocument();
    expect(state.keepAlives).toBe(0);
  });

  it('when the re-read at warning time shows the server ends sooner than a minute away, then the warning says the actual time left, not "1 minute"', async () => {
    const state = backend();
    await renderSignedIn(state);
    state.expiresAt = Date.now() + 14 * MINUTE + 25_000;

    await advance(14 * MINUTE + 1000);

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Still there?',
    });
    expect(dialog).toHaveAccessibleDescription(/signed out in 2\d seconds/);
  });

  it('when the server expiry is later but the clinician has not touched the tablet, then the client idle deadline warns at 14 minutes', async () => {
    const state = backend();
    state.expiresAt = Date.now() + 40 * MINUTE;
    await renderSignedIn(state);

    await advance(14 * MINUTE + 5000);

    expect(
      await screen.findByRole('alertdialog', {name: 'Still there?'}),
    ).toBeInTheDocument();
  });

  it('when the session read at warning time answers 401, then the session has ended: patient data is cleared', async () => {
    const state = backend();
    await renderSignedIn(state);
    state.expiresAt = null;

    await advance(14 * MINUTE + 5000);

    expect(await screen.findByText('session ended')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });
});

describe('given a signed-in chart and the app is hidden (W-7)', () => {
  it('when visibilitychange reports hidden, then patient data is covered synchronously, before the OS takes its snapshot', async () => {
    const state = backend();
    await renderSignedIn(state);

    setVisibility('hidden');

    expect(
      screen.getByRole('heading', {name: PATIENT_FAMILY, hidden: true}),
    ).not.toBeVisible();
    expect(screen.getByText('Patient data hidden')).toBeVisible();
  });

  it('when the clinician returns within the grace period, then the cover lifts and the chart is as it was, with no new read', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);
    setVisibility('hidden');

    await advance(30_000);
    setVisibility('visible');

    expect(screen.getByRole('heading', {name: PATIENT_FAMILY})).toBeVisible();
    expect(screen.queryByText('Patient data hidden')).not.toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
    expect(state.patientReads).toBe(1);
  });

  it('when the app stays hidden past the grace period, then it signs out, clearing patient data', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);
    setVisibility('hidden');

    await advance(61_000);

    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });

  it('when the page was frozen while hidden and returns after the grace period, then it signs out on return rather than uncovering', async () => {
    const state = backend();
    const {signOut} = await renderSignedIn(state);
    setVisibility('hidden');

    // A frozen page runs no timers; only the clock moves.
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    setVisibility('visible');

    expect(signOut).toHaveBeenCalledExactlyOnceWith({reason: 'idle'});
    expect(document.body).not.toHaveTextContent(PATIENT_FAMILY);
  });
});
