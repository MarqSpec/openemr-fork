import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {createHash} from 'node:crypto';
import type {FastifyInstance, LightMyRequestResponse} from 'fastify';
import {HttpResponse, delay, http} from 'msw';
import {setupServer} from 'msw/node';
import {buildServer, type ServerDeps} from './server.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  OPENEMR_BASE_URL,
  OPENID_DISCOVERY_URL,
  PUBLIC_ORIGIN,
  SMART_DISCOVERY_URL,
  makeSpaDist,
  testConfig,
} from './test/fixtures.js';
import {
  AUTHORIZE_URL,
  END_SESSION_URL,
  FHIR_BASE,
  JWKS_URL,
  POST_LOGOUT_REDIRECT_URI,
  REDIRECT_URI,
  REQUESTED_SCOPES,
  TOKEN_URL,
  createStubOpenemr,
  smartConfiguration,
  type IdTokenPlan,
  type StubOpenemr,
} from './test/stub_openemr.js';

const HANDSHAKE = '__Host-bff-handshake';
const SESSION = '__Host-bff-session';
const REASON = 'bff-logout-reason';
const TEN_MINUTES = 10 * 60 * 1000;
/** What the app's own sign-in / sign-out form post carries (FR-BFF-6). */
const OWN_FORM_POST = {
  'sec-fetch-site': 'same-origin',
  origin: PUBLIC_ORIGIN,
  'content-type': 'application/x-www-form-urlencoded',
};

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
});

afterEach(async () => {
  await app.close();
  openemr.resetHandlers();
});

afterAll(async () => {
  openemr.close();
  await dist.cleanup();
});

async function start(
  overrides: Parameters<typeof testConfig>[1] = {},
): Promise<FastifyInstance> {
  const deps: ServerDeps = {
    now: () => now,
    logStream: {
      write: (line: string) => {
        logLines.push(line);
      },
    },
  };
  app = buildServer(
    testConfig(dist.dir, {logLevel: 'trace', ...overrides}),
    deps,
  );
  await app.ready();
  return app;
}

function login(headers: Record<string, string> = OWN_FORM_POST) {
  return app.inject({method: 'POST', url: '/bff/login', headers, payload: ''});
}

function callback(query: string, cookies: Record<string, string> = {}) {
  return app.inject({method: 'GET', url: `/bff/callback?${query}`, cookies});
}

function logout(
  cookies: Record<string, string> = {},
  headers: Record<string, string> = OWN_FORM_POST,
  payload = '',
) {
  return app.inject({
    method: 'POST',
    url: '/bff/logout',
    headers,
    cookies,
    payload,
  });
}

function cookieNamed(response: LightMyRequestResponse, name: string) {
  return response.cookies.find(cookie => cookie.name === name);
}

/** The raw Set-Cookie line for one cookie, so attributes are checked exactly as the browser sees them. */
function setCookieLine(response: LightMyRequestResponse, name: string): string {
  const header = response.headers['set-cookie'];
  const lines = Array.isArray(header)
    ? header
    : header === undefined
      ? []
      : [header];
  const line = lines.find(l => l.startsWith(`${name}=`));
  expect(line, `Set-Cookie for ${name}`).toBeDefined();
  return String(line);
}

function attributes(line: string): Map<string, string> {
  return new Map(
    line
      .split(';')
      .slice(1)
      .map(part => part.trim())
      .map(part => {
        const eq = part.indexOf('=');
        return eq === -1
          ? [part.toLowerCase(), '']
          : [part.slice(0, eq).toLowerCase(), part.slice(eq + 1)];
      }),
  );
}

function expectCleared(response: LightMyRequestResponse, name: string): void {
  const attrs = attributes(setCookieLine(response, name));
  const expires = attrs.get('expires');
  const cleared =
    attrs.get('max-age') === '0' ||
    (expires !== undefined && Date.parse(expires) <= Date.now());
  expect(cleared, `${name} is cleared`).toBe(true);
}

function location(response: LightMyRequestResponse): string {
  return String(response.headers.location);
}

function expectSecurityHeaders(response: LightMyRequestResponse): void {
  const csp = String(response.headers['content-security-policy']);
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain(`form-action 'self' ${OPENEMR_BASE_URL}`);
  expect(response.headers['strict-transport-security']).toMatch(/max-age=/);
  expect(response.headers['referrer-policy']).toBe('same-origin');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['cache-control']).toBe('no-store');
}

/** API-40: returns the authorize URL and the handshake cookie value. */
async function startSignIn(): Promise<{authorize: URL; handshake: string}> {
  const response = await login();
  expect(response.statusCode).toBe(303);
  const handshake = cookieNamed(response, HANDSHAKE)?.value;
  expect(handshake).toBeDefined();
  return {authorize: new URL(location(response)), handshake: String(handshake)};
}

/** API-40 → OpenEMR approves → API-41; returns the callback response. */
async function signIn(plan: IdTokenPlan = {}) {
  const {authorize, handshake} = await startSignIn();
  const code = stub.approve(authorize.href, plan);
  const state = String(authorize.searchParams.get('state'));
  const response = await callback(
    `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    {[HANDSHAKE]: handshake},
  );
  return {response, authorize, handshake, code, state};
}

async function signedInSession(): Promise<string> {
  const {response} = await signIn();
  expect(response.statusCode).toBe(303);
  const session = cookieNamed(response, SESSION)?.value;
  expect(session).toBeDefined();
  return String(session);
}

/** A rejected callback: back to the app, no session, the handshake gone. */
function expectSignInRejected(
  response: LightMyRequestResponse,
  reason: 'signin_failed' | 'signin_unavailable',
): void {
  expect(response.statusCode).toBe(303);
  expect(location(response)).toBe(`/signed-out?reason=${reason}`);
  expect(cookieNamed(response, SESSION)).toBeUndefined();
  expectCleared(response, HANDSHAKE);
  expectSecurityHeaders(response);
}

describe('given API-40 — POST /bff/login, the start of sign-in', () => {
  beforeEach(async () => {
    await start();
  });

  it('when the app posts its own sign-in form, then it is 303ed to OpenEMR authorize with S256 PKCE, the §2 scopes, a nonce and the aud from SMART discovery (BUG-16, BUG-17)', async () => {
    const response = await login();

    expect(response.statusCode).toBe(303);
    const authorize = new URL(location(response));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(AUTHORIZE_URL);
    const params = authorize.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(params.get('scope')).toBe(REQUESTED_SCOPES.join(' '));
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('aud')).toBe(FHIR_BASE);
    expect(String(params.get('state')).length).toBeGreaterThanOrEqual(22);
    expect(String(params.get('nonce')).length).toBeGreaterThanOrEqual(22);
    expect(params.has('client_secret')).toBe(false);
    expect(authorize.href).not.toContain(CLIENT_SECRET);
    expectSecurityHeaders(response);
  });

  it('when SMART discovery names a different FHIR base, then aud follows discovery rather than being built', async () => {
    const smart = smartConfiguration();
    smart.issuer = `${OPENEMR_BASE_URL}/webroot/apis/default/fhir`;
    openemr.use(http.get(SMART_DISCOVERY_URL, () => HttpResponse.json(smart)));

    const response = await login();

    expect(new URL(location(response)).searchParams.get('aud')).toBe(
      `${OPENEMR_BASE_URL}/webroot/apis/default/fhir`,
    );
  });

  it('when sign-in starts, then the handshake cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, and lives at most 10 minutes (FR-BFF-1)', async () => {
    const response = await login();

    const line = setCookieLine(response, HANDSHAKE);
    const attrs = attributes(line);
    expect(attrs.has('httponly')).toBe(true);
    expect(attrs.has('secure')).toBe(true);
    expect(attrs.get('samesite')).toBe('Lax');
    expect(attrs.get('path')).toBe('/');
    expect(attrs.has('domain')).toBe(false);
    const maxAge = Number(attrs.get('max-age'));
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);
    expect(cookieNamed(response, SESSION)).toBeUndefined();
  });

  it('when sign-in starts, then the handshake cookie is an opaque id of at least 128 bits carrying no verifier, state or nonce', async () => {
    const response = await login();
    const handshake = String(cookieNamed(response, HANDSHAKE)?.value);
    const params = new URL(location(response)).searchParams;

    expect(handshake).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(handshake).not.toContain(String(params.get('state')));
    expect(handshake).not.toContain(String(params.get('nonce')));
    expect(response.body).not.toContain(String(params.get('state')));
  });

  it('when sign-in starts twice, then each attempt gets its own state, nonce, challenge and handshake', async () => {
    const first = await login();
    const second = await login();
    const a = new URL(location(first)).searchParams;
    const b = new URL(location(second)).searchParams;

    expect(a.get('state')).not.toBe(b.get('state'));
    expect(a.get('nonce')).not.toBe(b.get('nonce'));
    expect(a.get('code_challenge')).not.toBe(b.get('code_challenge'));
    expect(cookieNamed(first, HANDSHAKE)?.value).not.toBe(
      cookieNamed(second, HANDSHAKE)?.value,
    );
  });

  it('when OpenEMR discovery is down, then the browser is sent back to the app as "unavailable", with no handshake and no OpenEMR detail', async () => {
    openemr.use(
      http.get(SMART_DISCOVERY_URL, () =>
        HttpResponse.text('SYNTHETIC-UPSTREAM-DETAIL', {status: 500}),
      ),
    );

    const response = await login();

    expect(response.statusCode).toBe(303);
    expect(location(response)).toBe('/signed-out?reason=signin_unavailable');
    expect(cookieNamed(response, HANDSHAKE)).toBeUndefined();
    expect(response.body).not.toContain('SYNTHETIC-UPSTREAM-DETAIL');
    expectSecurityHeaders(response);
  });

  it('when a cross-site page posts to it, then it is 403 and no handshake is created or OpenEMR contacted (FR-BFF-6)', async () => {
    const response = await login({
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example.test',
      'content-type': 'application/x-www-form-urlencoded',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({error: 'forbidden'});
    expect(cookieNamed(response, HANDSHAKE)).toBeUndefined();
    expect(stub.counts.smart).toBe(0);
    expectSecurityHeaders(response);
  });

  it.each(['GET', 'HEAD', 'PUT', 'DELETE'] as const)(
    'when requested with %s, then it is 405 with Allow: POST and nothing is started (state changes are POST-only)',
    async method => {
      const response = await app.inject({
        method,
        url: '/bff/login',
        headers: {'sec-fetch-site': 'same-origin'},
      });

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe('POST');
      expect(cookieNamed(response, HANDSHAKE)).toBeUndefined();
      expect(stub.counts.smart).toBe(0);
      expectSecurityHeaders(response);
    },
  );
});

describe('given API-41 — GET /bff/callback, OpenEMR sending the browser back', () => {
  beforeEach(async () => {
    await start();
  });

  it('when state and the handshake match and the id_token is valid, then the session cookie is set, the handshake deleted, and the browser 303ed to the app', async () => {
    const {response} = await signIn();

    expect(response.statusCode).toBe(303);
    expect(location(response)).toBe('/');
    expectCleared(response, HANDSHAKE);
    const attrs = attributes(setCookieLine(response, SESSION));
    expect(attrs.has('httponly')).toBe(true);
    expect(attrs.has('secure')).toBe(true);
    expect(attrs.get('samesite')).toBe('Strict');
    expect(attrs.get('path')).toBe('/');
    expect(attrs.has('domain')).toBe(false);
    // A browser-session cookie: it dies with the browser; the server bounds the session itself.
    expect(attrs.has('max-age')).toBe(false);
    expect(attrs.has('expires')).toBe(false);
    expect(String(cookieNamed(response, SESSION)?.value)).toMatch(
      /^[A-Za-z0-9_-]{22,}$/,
    );
    expectSecurityHeaders(response);
  });

  it('when the code is exchanged, then the token handler authenticates as the confidential client (client_secret_post) with the PKCE verifier and the registered redirect_uri (API-4)', async () => {
    const {authorize} = await signIn();

    expect(stub.tokenRequests).toHaveLength(1);
    const body = stub.tokenRequests[0];
    expect(body?.get('grant_type')).toBe('authorization_code');
    expect(body?.get('client_id')).toBe(CLIENT_ID);
    expect(body?.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body?.get('redirect_uri')).toBe(REDIRECT_URI);
    const verifier = String(body?.get('code_verifier'));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    );
  });

  it('when sign-in completes, then no token, verifier, state, nonce or secret reaches the browser — not in a header, a cookie or the body', async () => {
    const {response, authorize} = await signIn();
    const verifier = String(stub.tokenRequests[0]?.get('code_verifier'));
    const tokens = stub.issued[0];
    const everything = JSON.stringify({
      headers: response.headers,
      body: response.body,
    });

    for (const secret of [
      tokens?.accessToken,
      tokens?.refreshToken,
      tokens?.idToken,
      verifier,
      String(authorize.searchParams.get('state')),
      String(authorize.searchParams.get('nonce')),
      CLIENT_SECRET,
    ]) {
      expect(everything).not.toContain(String(secret));
    }
  });

  it('when a full sign-in and sign-out run, then no log line carries a token, the code, state, nonce, verifier or the client secret (FR-BFF-5)', async () => {
    const {authorize, code} = await signIn();
    const session = String(
      cookieNamed((await signIn()).response, SESSION)?.value,
    );
    await logout({[SESSION]: session});
    const verifier = String(stub.tokenRequests[0]?.get('code_verifier'));
    const logs = logLines.join('');

    expect(logs).toContain('/bff/callback');
    for (const secret of [
      ...stub.issued.flatMap(t => [t.accessToken, t.refreshToken, t.idToken]),
      code,
      verifier,
      String(authorize.searchParams.get('state')),
      String(authorize.searchParams.get('nonce')),
      CLIENT_SECRET,
      session,
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it('when the handshake cookie is missing, then sign-in is rejected without calling the token endpoint', async () => {
    const {authorize} = await startSignIn();
    const code = stub.approve(authorize.href);

    const response = await callback(
      `code=${code}&state=${String(authorize.searchParams.get('state'))}`,
    );

    expectSignInRejected(response, 'signin_failed');
    expect(stub.tokenRequests).toHaveLength(0);
  });

  it('when the handshake cookie names no handshake, then sign-in is rejected', async () => {
    const {authorize} = await startSignIn();
    const code = stub.approve(authorize.href);

    const response = await callback(
      `code=${code}&state=${String(authorize.searchParams.get('state'))}`,
      {[HANDSHAKE]: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'},
    );

    expectSignInRejected(response, 'signin_failed');
    expect(stub.tokenRequests).toHaveLength(0);
  });

  it.each([
    ['missing', () => ''],
    ['wrong', () => 'state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['repeated', (state: string) => `state=${state}&state=${state}`],
  ])(
    'when state is %s, then sign-in is rejected without calling the token endpoint',
    async (_, stateParam) => {
      const {authorize, handshake} = await startSignIn();
      const code = stub.approve(authorize.href);
      const state = String(authorize.searchParams.get('state'));
      const extra = stateParam(state);

      const response = await callback(
        `code=${code}${extra === '' ? '' : `&${extra}`}`,
        {[HANDSHAKE]: handshake},
      );

      expectSignInRejected(response, 'signin_failed');
      expect(stub.tokenRequests).toHaveLength(0);
    },
  );

  it('when state matches another attempt’s handshake, then it is rejected (state is bound to its own handshake cookie)', async () => {
    const first = await startSignIn();
    const second = await startSignIn();
    const code = stub.approve(first.authorize.href);

    const response = await callback(
      `code=${code}&state=${String(first.authorize.searchParams.get('state'))}`,
      {[HANDSHAKE]: second.handshake},
    );

    expectSignInRejected(response, 'signin_failed');
  });

  it('when the code is missing, then sign-in is rejected', async () => {
    const {authorize, handshake} = await startSignIn();

    const response = await callback(
      `state=${String(authorize.searchParams.get('state'))}`,
      {[HANDSHAKE]: handshake},
    );

    expectSignInRejected(response, 'signin_failed');
    expect(stub.tokenRequests).toHaveLength(0);
  });

  it('when the handshake is older than 10 minutes, then sign-in is rejected without calling the token endpoint', async () => {
    const {authorize, handshake} = await startSignIn();
    const code = stub.approve(authorize.href);
    now += TEN_MINUTES + 1000;

    const response = await callback(
      `code=${code}&state=${String(authorize.searchParams.get('state'))}`,
      {[HANDSHAKE]: handshake},
    );

    expectSignInRejected(response, 'signin_failed');
    expect(stub.tokenRequests).toHaveLength(0);
  });

  it('when the same callback is replayed, then the second is rejected — the handshake is single-use — without reaching the token endpoint', async () => {
    const {handshake, code, state} = await signIn();

    const replay = await callback(`code=${code}&state=${state}`, {
      [HANDSHAKE]: handshake,
    });

    expectSignInRejected(replay, 'signin_failed');
    expect(stub.tokenRequests).toHaveLength(1);
  });

  it('when OpenEMR refuses a reused or expired code (invalid_grant), then sign-in is rejected', async () => {
    const {authorize, handshake} = await startSignIn();
    const code = stub.approve(authorize.href);
    // Spend the code first, as a second tab or an attacker would.
    await fetch(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        code_verifier: 'x'.repeat(43),
        redirect_uri: REDIRECT_URI,
      }),
    });

    const response = await callback(
      `code=${code}&state=${String(authorize.searchParams.get('state'))}`,
      {[HANDSHAKE]: handshake},
    );

    expectSignInRejected(response, 'signin_failed');
  });

  it('when OpenEMR sends the user back with an error (consent declined), then sign-in is rejected without calling the token endpoint', async () => {
    const {authorize, handshake} = await startSignIn();

    const response = await callback(
      `error=access_denied&state=${String(authorize.searchParams.get('state'))}`,
      {[HANDSHAKE]: handshake},
    );

    expectSignInRejected(response, 'signin_failed');
    expect(stub.tokenRequests).toHaveLength(0);
  });

  it.each([
    [
      '5xx',
      () => HttpResponse.text('SYNTHETIC-UPSTREAM-DETAIL', {status: 502}),
    ],
    ['a network failure', () => HttpResponse.error()],
    [
      'a timeout',
      async () => {
        await delay('infinite');
        return HttpResponse.json({});
      },
    ],
  ])(
    'when the token endpoint answers %s, then sign-in is "unavailable" and nothing from OpenEMR reaches the browser',
    async (_, resolver) => {
      openemr.use(http.post(TOKEN_URL, resolver));

      const {response} = await signIn();

      expectSignInRejected(response, 'signin_unavailable');
      expect(response.body).not.toContain('SYNTHETIC-UPSTREAM-DETAIL');
      expect(logLines.join('')).not.toContain('SYNTHETIC-UPSTREAM-DETAIL');
    },
  );

  it.each([
    ['no id_token', {id_token: undefined}],
    ['no access_token', {access_token: undefined}],
    ['a non-Bearer token_type', {token_type: 'mac'}],
    ['a non-numeric expires_in', {expires_in: 'soon'}],
  ])(
    'when the token response has %s, then sign-in is rejected',
    async (_, patch) => {
      openemr.use(
        http.post(TOKEN_URL, () =>
          HttpResponse.json({
            access_token: 'synthetic-access',
            id_token: 'synthetic.id.token',
            token_type: 'Bearer',
            expires_in: 3600,
            ...patch,
          }),
        ),
      );

      const {response} = await signIn();

      expectSignInRejected(response, 'signin_failed');
    },
  );

  it.each([
    [
      'iss is another issuer',
      {claims: {iss: 'https://evil.example.test/oauth2/default'}},
    ],
    ['aud is another client', {claims: {aud: 'another-client-id'}}],
    ['nonce does not match', {claims: {nonce: 'SYNTHETIC-WRONG-NONCE'}}],
    ['nonce is missing', {claims: {nonce: undefined}}],
    [
      'it has expired',
      {
        claims: {
          iat: Math.floor(Date.now() / 1000) - 7200,
          exp: Math.floor(Date.now() / 1000) - 3600,
        },
      },
    ],
    ['exp is missing', {claims: {exp: undefined}}],
    ['iat is missing', {claims: {iat: undefined}}],
    [
      'iat is in the future',
      {claims: {iat: Math.floor(Date.now() / 1000) + 3600}},
    ],
    [
      'it was issued long before the exchange',
      {claims: {iat: Math.floor(Date.now() / 1000) - 3600}},
    ],
    ['the signature is not OpenEMR’s', {key: 'untrusted'}],
    [
      'it is PS256, signed with OpenEMR’s own key (only RS256 is allowed)',
      {alg: 'PS256'},
    ],
    ['it is HS256 (a shared-secret algorithm)', {alg: 'HS256'}],
    ['its kid is not in the JWKS', {kid: 'stub-signing-key-unknown'}],
    ['sub is missing', {claims: {sub: undefined}}],
  ] satisfies [string, IdTokenPlan][])(
    'when the id_token is invalid because %s, then sign-in is rejected and no session is created',
    async (_, plan) => {
      const {response} = await signIn(plan);

      expectSignInRejected(response, 'signin_failed');
    },
  );

  it('when the id_token is unsigned (alg none), then sign-in is rejected', async () => {
    const header = Buffer.from(JSON.stringify({alg: 'none'})).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: `${OPENEMR_BASE_URL}/oauth2/default`,
        aud: CLIENT_ID,
      }),
    ).toString('base64url');
    openemr.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: 'synthetic-access',
          id_token: `${header}.${payload}.`,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      ),
    );

    const {response} = await signIn();

    expectSignInRejected(response, 'signin_failed');
  });

  it('when the JWKS endpoint fails, then sign-in is "unavailable" and no session is created', async () => {
    openemr.use(
      http.get(JWKS_URL, () =>
        HttpResponse.text('SYNTHETIC-UPSTREAM-DETAIL', {status: 500}),
      ),
    );

    const {response} = await signIn();

    expectSignInRejected(response, 'signin_unavailable');
    expect(response.body).not.toContain('SYNTHETIC-UPSTREAM-DETAIL');
  });

  it('when the id_token is rejected for a wrong nonce, then the log names the reason but not the nonce or the token', async () => {
    const {authorize} = await signIn({
      claims: {nonce: 'SYNTHETIC-WRONG-NONCE'},
    });
    const logs = logLines.join('');

    expect(logs).toMatch(/id_token/);
    expect(logs).not.toContain('SYNTHETIC-WRONG-NONCE');
    expect(logs).not.toContain(String(authorize.searchParams.get('nonce')));
    expect(logs).not.toContain(String(stub.issued[0]?.idToken));
  });

  it('when POSTed, then it is 405 with Allow: GET', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/callback',
      headers: OWN_FORM_POST,
      payload: '',
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('GET');
  });

  it('when a signed-in browser signs in again, then the old session is destroyed and a new id minted (no fixation)', async () => {
    const first = await signedInSession();
    const {authorize, handshake} = await startSignIn();
    const code = stub.approve(authorize.href);

    const response = await app.inject({
      method: 'GET',
      url: `/bff/callback?code=${code}&state=${String(authorize.searchParams.get('state'))}`,
      cookies: {[HANDSHAKE]: handshake, [SESSION]: first},
    });
    const second = String(cookieNamed(response, SESSION)?.value);

    expect(second).not.toBe(first);
    // The first session no longer exists: signing out with it goes straight to the app, not to OpenEMR.
    const out = await logout({[SESSION]: first});
    expect(location(out)).toBe('/signed-out');
  });
});

describe('given API-43 — POST /bff/logout', () => {
  beforeEach(async () => {
    await start();
  });

  it('when a signed-in user posts the sign-out form, then the session is destroyed, the cookie cleared and the browser 303ed to OpenEMR end-session with id_token_hint and the registered post-logout URI (BUG-5)', async () => {
    const session = await signedInSession();

    const response = await logout({[SESSION]: session});

    expect(response.statusCode).toBe(303);
    const endSession = new URL(location(response));
    expect(`${endSession.origin}${endSession.pathname}`).toBe(END_SESSION_URL);
    expect(endSession.searchParams.get('id_token_hint')).toBe(
      stub.issued[0]?.idToken,
    );
    expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(
      POST_LOGOUT_REDIRECT_URI,
    );
    expectCleared(response, SESSION);
    expectSecurityHeaders(response);

    // Destroyed server-side: the same cookie now names nothing.
    const again = await logout({[SESSION]: session});
    expect(location(again)).toBe('/signed-out');
  });

  it('when the session has been idle for the inactivity timeout, then its record is gone — a stolen cookie outlives nothing (FR-BFF-4)', async () => {
    const first = await signedInSession();
    const second = await signedInSession();

    now += 15 * 60 * 1000 - 1;
    const before = await logout({[SESSION]: first});
    expect(new URL(location(before)).pathname).toBe('/oauth2/default/logout');

    now += 1;
    const after = await logout({[SESSION]: second});
    expect(location(after)).toBe('/signed-out');
  });

  it('when OpenEMR discovery is down at sign-out, then the local session is still destroyed and the app is told OpenEMR’s session may still be open', async () => {
    await app.close();
    await start({
      session: {idleTimeoutMs: 2 * 3600 * 1000, maxSessionMs: 10 * 3600 * 1000},
    });
    const {response} = await signIn({expiresIn: 7200});
    const session = String(cookieNamed(response, SESSION)?.value);
    // Past the discovery cache, inside the session's lifetime.
    now += 60 * 60 * 1000 + 1000;
    openemr.use(
      http.get(SMART_DISCOVERY_URL, () => HttpResponse.error()),
      http.get(OPENID_DISCOVERY_URL, () => HttpResponse.error()),
    );

    const out = await logout({[SESSION]: session});

    expect(out.statusCode).toBe(303);
    expect(location(out)).toBe('/signed-out?reason=signout_partial');
    expectCleared(out, SESSION);
    expectSecurityHeaders(out);
    const again = await logout({[SESSION]: session});
    expect(location(again)).toBe('/signed-out');
  });

  it('when there is no session, then the cookie is cleared and the browser goes to /signed-out without contacting OpenEMR', async () => {
    const response = await logout();

    expect(response.statusCode).toBe(303);
    expect(location(response)).toBe('/signed-out');
    expectCleared(response, SESSION);
    expect(stub.counts.smart + stub.counts.openid).toBe(0);
  });

  it('when the form carries reason=idle, then post_logout_redirect_uri stays registered and a logout-reason cookie is set (BUG-5)', async () => {
    const session = await signedInSession();

    const response = await logout(
      {[SESSION]: session},
      OWN_FORM_POST,
      'reason=idle',
    );

    expect(response.statusCode).toBe(303);
    const endSession = new URL(location(response));
    expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(
      POST_LOGOUT_REDIRECT_URI,
    );
    const reasonCookie = setCookieLine(response, 'bff-logout-reason');
    expect(reasonCookie).toContain('idle');
    const reasonAttrs = attributes(reasonCookie);
    expect(reasonAttrs.get('samesite')).toBe('Lax');
    expect(reasonAttrs.get('max-age')).toBe('120');
    expect(reasonAttrs.has('httponly')).toBe(false);
  });

  it('when there is no session but the form carries reason=idle, then the browser goes to /signed-out?reason=idle', async () => {
    const response = await logout({}, OWN_FORM_POST, 'reason=idle');

    expect(response.statusCode).toBe(303);
    expect(location(response)).toBe('/signed-out?reason=idle');
  });

  it('when OpenEMR discovery is down and the form carries reason=idle, then signout_partial still wins', async () => {
    await app.close();
    await start({
      session: {idleTimeoutMs: 2 * 3600 * 1000, maxSessionMs: 10 * 3600 * 1000},
    });
    const {response} = await signIn({expiresIn: 7200});
    const session = String(cookieNamed(response, SESSION)?.value);
    now += 60 * 60 * 1000 + 1000;
    openemr.use(
      http.get(SMART_DISCOVERY_URL, () => HttpResponse.error()),
      http.get(OPENID_DISCOVERY_URL, () => HttpResponse.error()),
    );

    const out = await logout(
      {[SESSION]: session, [REASON]: 'idle'},
      OWN_FORM_POST,
      'reason=idle',
    );

    expect(location(out)).toBe('/signed-out?reason=signout_partial');
    expectCleared(out, REASON);
  });

  it('when the form carries an unknown reason, then it is ignored and no logout-reason cookie is set', async () => {
    const session = await signedInSession();

    const response = await logout(
      {[SESSION]: session},
      OWN_FORM_POST,
      'reason=Dr.%20Avery',
    );

    const endSession = new URL(location(response));
    expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(
      POST_LOGOUT_REDIRECT_URI,
    );
    expect(cookieNamed(response, REASON)?.value ?? '').toBe('');
  });

  it('when a manual sign-out follows an idle one whose cookie lingers, then the lingering logout-reason cookie is cleared', async () => {
    const session = await signedInSession();

    const response = await logout({[SESSION]: session, [REASON]: 'idle'});

    expect(response.statusCode).toBe(303);
    expect(cookieNamed(response, REASON)?.value).toBe('');
    expectCleared(response, REASON);
  });

  it('when there is no session and a logout-reason cookie lingers, then it is cleared', async () => {
    const response = await logout({[REASON]: 'idle'});

    expect(location(response)).toBe('/signed-out');
    expectCleared(response, REASON);
  });

  it('when a cross-site page posts to it, then it is 403 and the session survives (FR-BFF-6)', async () => {
    const session = await signedInSession();

    const response = await logout(
      {[SESSION]: session},
      {'sec-fetch-site': 'cross-site', origin: 'https://evil.example.test'},
    );

    expect(response.statusCode).toBe(403);
    expect(cookieNamed(response, SESSION)).toBeUndefined();
    const own = await logout({[SESSION]: session});
    expect(new URL(location(own)).pathname).toBe('/oauth2/default/logout');
  });

  it('when an older browser posts without Sec-Fetch-Site but with the app’s Origin, then it is accepted', async () => {
    const session = await signedInSession();

    const response = await logout(
      {[SESSION]: session},
      {
        origin: PUBLIC_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
    );

    expect(response.statusCode).toBe(303);
  });

  it.each([
    ['a foreign Origin', {origin: 'https://evil.example.test'}],
    ['Origin: null', {origin: 'null'}],
    ['neither header', {}],
    ['same-site', {'sec-fetch-site': 'same-site', origin: PUBLIC_ORIGIN}],
    ['Sec-Fetch-Site: none', {'sec-fetch-site': 'none'}],
  ])(
    'when it arrives with %s, then it is 403',
    async (_, headers: Record<string, string>) => {
      const response = await logout({}, headers);

      expect(response.statusCode).toBe(403);
      expectSecurityHeaders(response);
    },
  );

  it('when requested with GET, then it is 405 with Allow: POST and the session survives', async () => {
    const session = await signedInSession();

    const response = await app.inject({
      method: 'GET',
      url: '/bff/logout',
      cookies: {[SESSION]: session},
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('POST');
    const own = await logout({[SESSION]: session});
    expect(new URL(location(own)).pathname).toBe('/oauth2/default/logout');
  });

  it('when the handshake cookie’s value is presented as a session, then it is not one (the handshake is accepted by API-41 only)', async () => {
    const {handshake} = await startSignIn();

    const response = await logout({[SESSION]: handshake});

    expect(location(response)).toBe('/signed-out');
  });
});

describe('given local development over plain http (BFF_DEV_INSECURE_COOKIES)', () => {
  beforeEach(async () => {
    await start({
      publicOrigin: 'http://localhost:5173',
      cookieMode: 'dev-insecure',
    });
  });

  it('when sign-in starts, then the handshake cookie drops __Host- and Secure but keeps HttpOnly, SameSite=Lax and Path=/', async () => {
    const response = await login({
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    });

    expect(cookieNamed(response, HANDSHAKE)).toBeUndefined();
    const attrs = attributes(setCookieLine(response, 'bff-handshake'));
    expect(attrs.has('secure')).toBe(false);
    expect(attrs.has('httponly')).toBe(true);
    expect(attrs.get('samesite')).toBe('Lax');
    expect(attrs.get('path')).toBe('/');
    expect(new URL(location(response)).searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/bff/callback',
    );
  });

  it('when sign-in completes, then the session cookie is bff-session, HttpOnly, SameSite=Strict, not Secure', async () => {
    const begun = await login({
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    });
    const authorize = new URL(location(begun));
    const handshake = String(cookieNamed(begun, 'bff-handshake')?.value);
    const code = stub.approve(authorize.href);

    const response = await callback(
      `code=${code}&state=${String(authorize.searchParams.get('state'))}`,
      {'bff-handshake': handshake},
    );

    expect(location(response)).toBe('/');
    const attrs = attributes(setCookieLine(response, 'bff-session'));
    expect(attrs.has('secure')).toBe(false);
    expect(attrs.has('httponly')).toBe(true);
    expect(attrs.get('samesite')).toBe('Strict');
  });
});

describe('given a sign-in with an OpenEMR discovery that is slow the first time', () => {
  it('when discovery is cached, then a second sign-in does not ask OpenEMR again', async () => {
    await start();
    await login();
    await login();

    expect(stub.counts.smart).toBe(1);
    expect(stub.counts.openid).toBe(1);
  });

  it('when OpenID discovery is down, then sign-in is unavailable', async () => {
    await start();
    openemr.use(
      http.get(
        OPENID_DISCOVERY_URL,
        () => new HttpResponse(null, {status: 404}),
      ),
    );

    const response = await login();

    expect(location(response)).toBe('/signed-out?reason=signin_unavailable');
  });
});
