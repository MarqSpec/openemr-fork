import {http, HttpResponse} from 'msw';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {server} from '../../test/msw_server';
import {ApiError} from '../api_error';
import type {ApiFailure} from '../api_error';
import {readSession} from './session';

// reference: INTERFACES.md API-42 · REQUIREMENTS.md FR-UI-3, FR-AUTH-5, NFR-CON-2

const SESSION_URL = '/bff/session';

/** A signed-in API-42 body as the token handler sends it; synthetic clinician. */
function signedIn(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    user: {displayName: 'Dr. Avery Demo'},
    expiresAt: '2026-09-25T18:00:00.000Z',
    idleTimeoutSeconds: 900,
    grantedScopes: ['openid', 'fhirUser', 'user/Patient.read'],
    ...overrides,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.failure;
    throw error;
  }
  throw new Error('expected the request to fail');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('given the session read (API-42)', () => {
  it('when it is sent, then it is a same-origin GET to /bff/session with the session cookie and no Authorization header', async () => {
    let seen: Request | undefined;
    server.use(
      http.get(SESSION_URL, ({request}) => {
        seen = request;
        return HttpResponse.json(signedIn());
      }),
    );

    await readSession();

    const url = new URL(seen?.url ?? '');
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe('/bff/session');
    expect(url.search).toBe('');
    expect(seen?.method).toBe('GET');
    expect(seen?.credentials).toBe('same-origin');
    expect(seen?.headers.get('Authorization')).toBeNull();
  });

  it('when a session is live, then the signed-in clinician and the session limits are returned', async () => {
    server.use(
      http.get(SESSION_URL, () =>
        HttpResponse.json(signedIn(), {
          headers: {Date: 'Fri, 25 Sep 2026 17:50:00 GMT'},
        }),
      ),
    );

    await expect(readSession()).resolves.toEqual({
      displayName: 'Dr. Avery Demo',
      expiresAt: '2026-09-25T18:00:00.000Z',
      expiresInMs: 10 * 60 * 1000,
      idleTimeoutSeconds: 900,
      grantedScopes: ['openid', 'fhirUser', 'user/Patient.read'],
    });
  });

  it('when the tablet clock is 5 minutes behind the server, then the time left is measured on the server clock (guards a countdown that outlives the server session)', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-09-25T17:45:00.000Z'),
    });
    server.use(
      http.get(SESSION_URL, () =>
        HttpResponse.json(signedIn(), {
          headers: {Date: 'Fri, 25 Sep 2026 17:50:00 GMT'},
        }),
      ),
    );

    await expect(readSession()).resolves.toMatchObject({
      expiresInMs: 10 * 60 * 1000,
    });
  });

  it('when the answer carries no usable Date header, then the time left falls back to the tablet clock', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-09-25T17:56:00.000Z'),
    });
    server.use(http.get(SESSION_URL, () => HttpResponse.json(signedIn())));

    await expect(readSession()).resolves.toMatchObject({
      expiresInMs: 4 * 60 * 1000,
    });
  });

  it('when OpenEMR would not give the clinician name (BUG-10), then the session is live with no display name', async () => {
    server.use(
      http.get(SESSION_URL, () =>
        HttpResponse.json(signedIn({user: {displayName: null}})),
      ),
    );

    await expect(readSession()).resolves.toMatchObject({displayName: null});
  });

  it('when the display name is blank, then it is treated as no name rather than an empty label', async () => {
    server.use(
      http.get(SESSION_URL, () =>
        HttpResponse.json(signedIn({user: {displayName: '   '}})),
      ),
    );

    await expect(readSession()).resolves.toMatchObject({displayName: null});
  });

  it('when there is no session (401), then it fails as session-over for API-42', async () => {
    server.use(
      http.get(SESSION_URL, () =>
        HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
      ),
    );

    expect(await failureOf(readSession())).toEqual({
      kind: 'session-over',
      apiId: 'API-42',
      status: 401,
      body: {format: 'unrecognised'},
    });
  });

  it('when the token handler fails (503), then it is a server error, not a sign-out', async () => {
    server.use(
      http.get(SESSION_URL, () => new HttpResponse(null, {status: 503})),
    );

    expect(await failureOf(readSession())).toMatchObject({
      kind: 'server-error',
      apiId: 'API-42',
      status: 503,
    });
  });

  it('when the network is down, then it is a network error', async () => {
    server.use(http.get(SESSION_URL, () => HttpResponse.error()));

    expect(await failureOf(readSession())).toEqual({
      kind: 'network-error',
      apiId: 'API-42',
    });
  });

  it.each([
    ['an HTML page', () => new HttpResponse('<html></html>', {status: 200})],
    [
      'authenticated: false',
      () => HttpResponse.json(signedIn({authenticated: false})),
    ],
    ['no expiry', () => HttpResponse.json(signedIn({expiresAt: undefined}))],
    [
      'an expiry that is not a timestamp',
      () => HttpResponse.json(signedIn({expiresAt: 'soon'})),
    ],
    [
      'a non-numeric idle timeout',
      () => HttpResponse.json(signedIn({idleTimeoutSeconds: '900'})),
    ],
  ])(
    'when a 200 carries %s, then it is a malformed response and no session is assumed',
    async (_label, respond) => {
      server.use(http.get(SESSION_URL, respond));

      expect(await failureOf(readSession())).toEqual({
        kind: 'malformed-response',
        apiId: 'API-42',
        status: 200,
      });
    },
  );
});
