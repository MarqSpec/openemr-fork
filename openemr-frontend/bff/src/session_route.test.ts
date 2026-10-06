import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type {FastifyInstance, LightMyRequestResponse} from 'fastify';
import {setupServer} from 'msw/node';
import {buildServer} from './server.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  PUBLIC_ORIGIN,
  makeSpaDist,
  testConfig,
} from './test/fixtures.js';
import {
  REQUESTED_SCOPES,
  createStubOpenemr,
  type IdTokenPlan,
  type StubOpenemr,
} from './test/stub_openemr.js';

const HANDSHAKE = '__Host-bff-handshake';
const SESSION = '__Host-bff-session';
const MINUTE = 60 * 1000;
const OWN_FORM_POST = {
  'sec-fetch-site': 'same-origin',
  origin: PUBLIC_ORIGIN,
  'content-type': 'application/x-www-form-urlencoded',
};
/** What OpenEMR grants in the stub: everything but Appointment (consent narrowed it, BUG-20). */
const GRANTED = REQUESTED_SCOPES.filter(s => s !== 'user/Appointment.read');

const openemr = setupServer();
let dist: Awaited<ReturnType<typeof makeSpaDist>>;
let stub: StubOpenemr;
let app: FastifyInstance;
let logLines: string[];
let now: number;

beforeAll(async () => {
  openemr.listen({onUnhandledRequest: 'error'});
  dist = await makeSpaDist();
});

beforeEach(async () => {
  stub = await createStubOpenemr();
  openemr.use(...stub.handlers);
  logLines = [];
  now = Date.now();
  app = buildServer(testConfig(dist.dir, {logLevel: 'trace'}), {
    now: () => now,
    logStream: {
      write: (line: string) => {
        logLines.push(line);
      },
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  openemr.resetHandlers();
});

afterAll(async () => {
  openemr.close();
  await dist.cleanup();
});

async function signIn(plan: IdTokenPlan = {}): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/bff/login',
    headers: OWN_FORM_POST,
    payload: '',
  });
  const authorize = new URL(String(login.headers.location));
  const handshake = String(
    login.cookies.find(c => c.name === HANDSHAKE)?.value,
  );
  const code = stub.approve(authorize.href, plan);
  const state = String(authorize.searchParams.get('state'));
  const callback = await app.inject({
    method: 'GET',
    url: `/bff/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: {[HANDSHAKE]: handshake},
  });
  const session = callback.cookies.find(c => c.name === SESSION)?.value;
  expect(session).toBeDefined();
  return String(session);
}

function readSession(session?: string) {
  return app.inject({
    method: 'GET',
    url: '/bff/session',
    cookies: session === undefined ? {} : {[SESSION]: session},
  });
}

function expectHardened(response: LightMyRequestResponse): void {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(String(response.headers['content-security-policy'])).toContain(
    "connect-src 'self'",
  );
  expect(response.headers['strict-transport-security']).toMatch(/max-age=/);
  expect(response.headers['referrer-policy']).toBe('same-origin');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
}

describe('given API-42 — GET /bff/session', () => {
  it('when a signed-in user asks, then it answers with their own display name, the session expiry, the idle timeout and the granted scopes — and nothing else', async () => {
    const session = await signIn();
    const signedInAt = now;

    const response = await readSession(session);

    expect(response.statusCode).toBe(200);
    expectHardened(response);
    expect(response.json()).toEqual({
      authenticated: true,
      user: {displayName: 'Synthetic Q Clinician'},
      expiresAt: new Date(signedInAt + 15 * MINUTE).toISOString(),
      idleTimeoutSeconds: 900,
      grantedScopes: GRANTED,
    });
  });

  it('when there is no session cookie, then it is 401 with the headers and no-store', async () => {
    const response = await readSession();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({error: 'unauthenticated'});
    expectHardened(response);
  });

  it('when the cookie names no session (made up, signed out, or the handshake id), then it is 401', async () => {
    const session = await signIn();
    await app.inject({
      method: 'POST',
      url: '/bff/logout',
      headers: OWN_FORM_POST,
      cookies: {[SESSION]: session},
      payload: '',
    });

    expect((await readSession(session)).statusCode).toBe(401);
    expect((await readSession('A'.repeat(43))).statusCode).toBe(401);
    expect((await readSession('not an id')).statusCode).toBe(401);
  });

  it('when the SPA polls it, then the polling does not keep the session alive: it ends at the idle timeout', async () => {
    const session = await signIn();

    for (let minute = 1; minute < 15; minute++) {
      now += MINUTE;
      expect((await readSession(session)).statusCode).toBe(200);
    }
    now += MINUTE;

    expect((await readSession(session)).statusCode).toBe(401);
  });

  it('when polled, then the expiry it reports does not move', async () => {
    const session = await signIn();
    const first = (await readSession(session)).json<{expiresAt: string}>();

    now += 5 * MINUTE;
    const later = (await readSession(session)).json<{expiresAt: string}>();

    expect(later.expiresAt).toBe(first.expiresAt);
  });

  it('when polled, then the display name is looked up once per session (API-18)', async () => {
    const session = await signIn();

    await readSession(session);
    await readSession(session);
    await readSession(session);

    expect(stub.counts.practitioner).toBe(1);
  });

  it('when the user may not read their own Practitioner (BUG-10), then the display name is null and the session is unharmed', async () => {
    stub.practitionerStatus = 403;
    const session = await signIn();

    const response = await readSession(session);

    expect(response.statusCode).toBe(200);
    expect(response.json<{user: {displayName: string | null}}>().user).toEqual({
      displayName: null,
    });
    await readSession(session);
    expect(stub.counts.practitioner).toBe(1);
  });

  it('when the id_token names no Practitioner as fhirUser, then the display name is null and OpenEMR is not asked', async () => {
    const session = await signIn({claims: {fhirUser: undefined}});

    const response = await readSession(session);

    expect(response.json<{user: unknown}>().user).toEqual({displayName: null});
    expect(stub.counts.practitioner).toBe(0);
  });

  it('when fhirUser points off the FHIR base, then it is never fetched with the bearer', async () => {
    const session = await signIn({
      claims: {fhirUser: 'https://elsewhere.example.test/Practitioner/x'},
    });

    const response = await readSession(session);

    expect(response.json<{user: unknown}>().user).toEqual({displayName: null});
    expect(stub.counts.practitioner).toBe(0);
  });

  it('when read, then no token, the session id or the client secret is in the body or a log line', async () => {
    const session = await signIn();
    const response = await readSession(session);
    const everything = JSON.stringify({
      headers: response.headers,
      body: response.body,
    });
    const logs = logLines.join('');

    for (const secret of [
      ...stub.issued.flatMap(t => [t.accessToken, t.refreshToken, t.idToken]),
      CLIENT_SECRET,
    ]) {
      expect(everything).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(logs).not.toContain(session);
  });

  it('when requested with another method, then it is 405 with Allow: GET', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD'] as const) {
      const response = await app.inject({
        method,
        url: '/bff/session',
        headers: OWN_FORM_POST,
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe('GET');
    }
  });
});

describe('given a session whose access token nears expiry (API-5, BUG-19)', () => {
  /**
   * Keeps the session active through the lifecycle, as the FHIR proxy will, for an hour — past the refresh
   * margin — and returns the refresh requests OpenEMR received.
   */
  async function activeForAnHour(session: string): Promise<URLSearchParams[]> {
    for (let minute = 10; minute <= 60; minute += 10) {
      now += 10 * MINUTE;
      await sessionsOf(app).getAccessToken(session);
    }
    return stub.tokenRequests.filter(
      r => r.get('grant_type') === 'refresh_token',
    );
  }

  it('when the token must be refreshed, then the token handler does it as the confidential client, with the refresh token and no scope (so none is dropped)', async () => {
    const session = await signIn();

    const refreshes = await activeForAnHour(session);

    expect(refreshes.map(r => Object.fromEntries(r))).toEqual([
      {
        grant_type: 'refresh_token',
        refresh_token: stub.issued[0]?.refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      },
    ]);
    expect(await sessionsOf(app).getAccessToken(session)).toBe(
      stub.issued[1]?.accessToken,
    );
    expect((await readSession(session)).statusCode).toBe(200);
  });

  it('when OpenEMR rotates the refresh token, then the next refresh uses the rotated one — the revoked one would end the session', async () => {
    const session = await signIn();
    await activeForAnHour(session);

    const refreshes = await activeForAnHour(session);

    expect(refreshes.map(r => r.get('refresh_token'))).toEqual([
      stub.issued[0]?.refreshToken,
      stub.issued[1]?.refreshToken,
    ]);
    expect((await readSession(session)).statusCode).toBe(200);
  });

  it('when OpenEMR refuses the refresh (invalid_grant), then the session is over: /bff/session is 401 and the log names the reason, not a token', async () => {
    const session = await signIn();
    stub.refreshBehaviour = 'invalid_grant';

    expect(await activeForAnHour(session)).toHaveLength(1);

    expect((await readSession(session)).statusCode).toBe(401);
    const logs = logLines.join('');
    expect(logs).toContain('refresh_rejected');
    expect(logs).toContain('invalid_grant');
    for (const secret of [
      ...stub.issued.flatMap(t => [t.accessToken, t.refreshToken, t.idToken]),
      CLIENT_SECRET,
      session,
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it.each([
    ['server_error', 'refresh_unavailable'],
    ['network_error', 'refresh_unavailable'],
    ['malformed', 'refresh_invalid_response'],
  ] as const)(
    'when the refresh fails (%s), then the session is over and the log says %s',
    async (behaviour, reason) => {
      const session = await signIn();
      stub.refreshBehaviour = behaviour;

      expect(await activeForAnHour(session)).toHaveLength(1);

      expect((await readSession(session)).statusCode).toBe(401);
      expect(logLines.join('')).toContain(reason);
    },
  );
});

/** The server's session lifecycle, as the proxy routes reach it. */
function sessionsOf(server: FastifyInstance) {
  return server.sessions;
}

describe('given the maximum session length (PRD Q-2: 10 h)', () => {
  it('when the maximum session length has passed, then /bff/session is 401 however active the user was', async () => {
    const session = await signIn();
    const lifecycle = sessionsOf(app);
    for (let minute = 10; minute < 600; minute += 10) {
      now += 10 * MINUTE;
      expect(await lifecycle.getAccessToken(session)).toBeDefined();
    }
    expect((await readSession(session)).statusCode).toBe(200);

    now += 10 * MINUTE;

    expect((await readSession(session)).statusCode).toBe(401);
  });
});

describe('given OpenEMR granted no refresh token (offline_access declined, !139 note 94239)', () => {
  const SHORT_LIVED = {offlineAccess: false, expiresIn: 10 * 60};

  it('when the access token lapses before the idle deadline, then /bff/session reports the lapse as the expiry, not the idle deadline', async () => {
    const signedInAt = now;
    const session = await signIn(SHORT_LIVED);

    const response = await readSession(session);

    expect(response.statusCode).toBe(200);
    expect(response.json<{expiresAt: string}>().expiresAt).toBe(
      new Date(signedInAt + 10 * MINUTE).toISOString(),
    );
  });

  it('when the access token has lapsed, then /bff/session is 401: the session ended with it', async () => {
    const session = await signIn(SHORT_LIVED);

    now += 10 * MINUTE;

    expect((await readSession(session)).statusCode).toBe(401);
  });
});
