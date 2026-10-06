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
  CLIENT_SECRET,
  PUBLIC_ORIGIN,
  makeSpaDist,
  testConfig,
} from './test/fixtures.js';
import {
  createStubOpenemr,
  type IdTokenPlan,
  type StubOpenemr,
} from './test/stub_openemr.js';

// reference: INTERFACES.md API-46; REQUIREMENTS.md FR-AUTH-4, FR-BFF-4, FR-BFF-6; REQUIREMENTS.md Q-2;

const HANDSHAKE = '__Host-bff-handshake';
const SESSION = '__Host-bff-session';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const OWN_FORM_POST = {
  'sec-fetch-site': 'same-origin',
  origin: PUBLIC_ORIGIN,
  'content-type': 'application/x-www-form-urlencoded',
};
/** What the SPA's same-origin `fetch` POST sends: no body, so no content type. */
const OWN_FETCH = {'sec-fetch-site': 'same-origin', origin: PUBLIC_ORIGIN};

/** Requests the FR-BFF-6 guard refuses, by who would send them. */
const REFUSED: [string, Record<string, string>][] = [
  ['a cross-site page', {'sec-fetch-site': 'cross-site'}],
  ['a same-site sibling', {'sec-fetch-site': 'same-site'}],
  ['a typed URL (none)', {'sec-fetch-site': 'none'}],
  ['another Origin', {origin: 'https://attacker.example.test'}],
  ['Origin null', {origin: 'null'}],
  ['no provenance at all', {}],
];

const openemr = setupServer();
let dist: Awaited<ReturnType<typeof makeSpaDist>>;
let stub: StubOpenemr;
let app: FastifyInstance;
let logLines: string[];
let now: number;
/** Every request that reached (faked) OpenEMR since the last sign-in finished. */
let upstream: string[];

beforeAll(async () => {
  openemr.listen({onUnhandledRequest: 'error'});
  openemr.events.on('request:start', ({request}) => {
    upstream.push(`${request.method} ${request.url}`);
  });
  dist = await makeSpaDist();
});

beforeEach(async () => {
  stub = await createStubOpenemr();
  openemr.use(...stub.handlers);
  logLines = [];
  upstream = [];
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
  // Warm the display name (API-18) so later reads of /bff/session do not reach OpenEMR either.
  await readSession(String(session));
  upstream = [];
  return String(session);
}

function activity(
  session?: string,
  headers: Record<string, string> = OWN_FETCH,
) {
  return app.inject({
    method: 'POST',
    url: '/bff/session/activity',
    headers,
    cookies: session === undefined ? {} : {[SESSION]: session},
  });
}

function readSession(session: string) {
  return app.inject({
    method: 'GET',
    url: '/bff/session',
    cookies: {[SESSION]: session},
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

describe('given API-46 — POST /bff/session/activity ("Stay signed in")', () => {
  it('when the signed-in SPA posts it, then it restarts the idle clock and answers only the new expiry — which /bff/session then reports', async () => {
    const session = await signIn();
    now += 10 * MINUTE;

    const response = await activity(session);

    expect(response.statusCode).toBe(200);
    expectHardened(response);
    const expiresAt = new Date(now + 15 * MINUTE).toISOString();
    expect(response.json()).toEqual({expiresAt});
    expect(
      (await readSession(session)).json<{expiresAt: string}>().expiresAt,
    ).toBe(expiresAt);
  });

  it('when it is posted as an empty form (no fetch body) too, then it is accepted', async () => {
    const session = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/bff/session/activity',
      headers: OWN_FORM_POST,
      cookies: {[SESSION]: session},
      payload: '',
    });

    expect(response.statusCode).toBe(200);
  });

  it('when posted just before the idle deadline, then the session outlives it (guards a keep-alive that does not keep alive)', async () => {
    const session = await signIn();
    now += 15 * MINUTE - 1000;
    expect((await activity(session)).statusCode).toBe(200);

    now += 10 * MINUTE;

    expect((await readSession(session)).statusCode).toBe(200);
  });

  it('when posted, then OpenEMR is never called — not even when the access token is due for a refresh (guards BUG-28 latency and a PHI-bearing keep-alive)', async () => {
    const session = await signIn();
    for (let minute = 10; minute <= 60; minute += 10) {
      now += 10 * MINUTE;
      expect((await activity(session)).statusCode).toBe(200);
    }

    expect(upstream).toEqual([]);
    expect(
      stub.tokenRequests.filter(r => r.get('grant_type') === 'refresh_token'),
    ).toEqual([]);
  });

  it('when there is no session cookie, then it is 401 unauthenticated with the headers', async () => {
    const response = await activity();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({error: 'unauthenticated'});
    expectHardened(response);
  });

  it('when the cookie names no session (made up, malformed, or signed out), then it is 401 and no session is created', async () => {
    const session = await signIn();
    await app.inject({
      method: 'POST',
      url: '/bff/logout',
      headers: OWN_FORM_POST,
      cookies: {[SESSION]: session},
      payload: '',
    });

    for (const id of [session, 'A'.repeat(43), 'not an id']) {
      expect((await activity(id)).statusCode).toBe(401);
    }
    expect((await readSession(session)).statusCode).toBe(401);
  });

  it('when the session has already timed out, then it is 401 and is not revived: /bff/session stays 401', async () => {
    const session = await signIn();
    now += 15 * MINUTE;

    expect((await activity(session)).statusCode).toBe(401);
    expect((await readSession(session)).statusCode).toBe(401);
    expect((await activity(session)).statusCode).toBe(401);
  });

  it('when the user keeps extending, then the expiry stops at the 10 h maximum and the session ends there (PRD Q-2)', async () => {
    const session = await signIn();
    const signedInAt = now;
    let last: LightMyRequestResponse | undefined;
    for (let spent = 0; spent < 10 * HOUR - 10 * MINUTE; spent += 10 * MINUTE) {
      now += 10 * MINUTE;
      last = await activity(session);
      expect(last.statusCode).toBe(200);
    }
    expect(last?.json()).toEqual({
      expiresAt: new Date(signedInAt + 10 * HOUR).toISOString(),
    });

    now = signedInAt + 10 * HOUR;

    expect((await activity(session)).statusCode).toBe(401);
    expect((await readSession(session)).statusCode).toBe(401);
  });

  it.each(REFUSED)(
    'when %s posts it (FR-BFF-6), then it is 403 forbidden and the idle clock does not move',
    async (_who, headers) => {
      const session = await signIn();
      const before = (await readSession(session)).json<{expiresAt: string}>();
      now += 10 * MINUTE;

      const response = await activity(session, headers);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({error: 'forbidden'});
      expectHardened(response);
      expect(
        (await readSession(session)).json<{expiresAt: string}>().expiresAt,
      ).toBe(before.expiresAt);
    },
  );

  it('when requested with another method, then it is 405 with Allow: POST and the idle clock does not move — state changes are POST-only', async () => {
    const session = await signIn();
    const before = (await readSession(session)).json<{expiresAt: string}>();
    now += 10 * MINUTE;

    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/bff/session/activity',
        headers: OWN_FETCH,
        cookies: {[SESSION]: session},
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe('POST');
    }
    expect(
      (await readSession(session)).json<{expiresAt: string}>().expiresAt,
    ).toBe(before.expiresAt);
  });

  it('when posted, then no token, the session id or the client secret is in the answer or a log line', async () => {
    const session = await signIn();
    const response = await activity(session);
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
    expect(everything).not.toContain(session);
    expect(logs).not.toContain(session);
  });
});

describe('given OpenEMR granted no refresh token (offline_access declined, !139 note 94239)', () => {
  it('when "Stay signed in" is posted with the access token lapsing before the new idle deadline, then the expiry answered is the lapse — and /bff/session agrees', async () => {
    const signedInAt = now;
    const session = await signIn({offlineAccess: false, expiresIn: 20 * 60});
    now += 10 * MINUTE;

    const response = await activity(session);

    expect(response.statusCode).toBe(200);
    const expiresAt = new Date(signedInAt + 20 * MINUTE).toISOString();
    expect(response.json()).toEqual({expiresAt});
    expect(
      (await readSession(session)).json<{expiresAt: string}>().expiresAt,
    ).toBe(expiresAt);
    expect(upstream).toEqual([]);
  });
});
