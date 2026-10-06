import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {FastifyInstance, LightMyRequestResponse} from 'fastify';
import net from 'node:net';
import type {AddressInfo} from 'node:net';
import {HttpResponse, delay} from 'msw';
import {setupServer} from 'msw/node';
import {
  DEFAULT_QUEUE_LIMITS,
  FhirProxyMetrics,
  MAX_BODY_BYTES,
  type AccessTokenResolver,
} from './fhir_proxy.js';
import {buildServer, type ServerDeps} from './server.js';
import {PUBLIC_ORIGIN, makeSpaDist, testConfig} from './test/fixtures.js';
import {
  FHIR_BASE,
  FHIR_USER,
  PLANTED_MRN,
  PLANTED_NAME,
  createStubOpenemr,
  defaultFhirAnswer,
  type FhirCall,
  type StubOpenemr,
} from './test/stub_openemr.js';

// reference: INTERFACES.md API-44, API-10…24 · REQUIREMENTS.md FR-BFF-3, FR-BFF-5, NFR-SEC-5, NFR-SEC-6
// reference: REQUIREMENTS.md BUG-28, BUG-33, BUG-38

const HANDSHAKE = '__Host-bff-handshake';
const SESSION = '__Host-bff-session';
const OWN_FORM_POST = {
  'sec-fetch-site': 'same-origin',
  origin: PUBLIC_ORIGIN,
  'content-type': 'application/x-www-form-urlencoded',
};
/** What the SPA's transport sends (src/api/fhir/transport.ts): a same-origin fetch, FHIR JSON, no Authorization. */
const SPA_FETCH = {
  'sec-fetch-site': 'same-origin',
  accept: 'application/fhir+json',
};
const PATIENT_ID = '9a1b2c3d-0000-4000-8000-00000000abcd';
const PRACTITIONER_ID = '9a1b2c3d-0000-4000-8000-0000000000p1';
/** The stub's own clinician, whose Practitioner the display-name lookup also reads. */
const FHIR_USER_ID = 'synthetic-practitioner-0001';
const ORGANIZATION_ID = '9a1b2c3d-0000-4000-8000-0000000000o1';

const openemr = setupServer();
/** Every request that left the token handler, whatever its destination. */
const outbound: string[] = [];
let dist: Awaited<ReturnType<typeof makeSpaDist>>;
let stub: StubOpenemr;
let app: FastifyInstance;
let logLines: string[];
let now: number;
let metrics: FhirProxyMetrics;

beforeAll(async () => {
  openemr.listen({onUnhandledRequest: 'error'});
  openemr.events.on('request:start', ({request}) => {
    outbound.push(request.url);
  });
  dist = await makeSpaDist();
});

beforeEach(async () => {
  stub = await createStubOpenemr();
  openemr.use(...stub.handlers);
  logLines = [];
  outbound.length = 0;
  now = Date.now();
  metrics = new FhirProxyMetrics();
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
  extra: Partial<ServerDeps> = {},
): Promise<FastifyInstance> {
  const deps: ServerDeps = {
    now: () => now,
    logStream: {
      write: (line: string) => {
        logLines.push(line);
      },
    },
    fhirMetrics: metrics,
    ...extra,
  };
  app = buildServer(
    testConfig(dist.dir, {logLevel: 'trace', ...overrides}),
    deps,
  );
  await app.ready();
  return app;
}

/** API-40 → OpenEMR approves → API-41; returns the session cookie and the access token OpenEMR issued. */
async function signIn(): Promise<{session: string; accessToken: string}> {
  const login = await app.inject({
    method: 'POST',
    url: '/bff/login',
    headers: OWN_FORM_POST,
    payload: '',
  });
  const handshake = login.cookies.find(c => c.name === HANDSHAKE)?.value;
  const authorize = new URL(String(login.headers.location));
  const code = stub.approve(authorize.href);
  const state = String(authorize.searchParams.get('state'));
  const callback = await app.inject({
    method: 'GET',
    url: `/bff/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: {[HANDSHAKE]: String(handshake)},
  });
  const session = callback.cookies.find(c => c.name === SESSION)?.value;
  expect(session, 'sign-in produced a session').toBeDefined();
  const issued = stub.issued.at(-1);
  expect(issued).toBeDefined();
  return {session: String(session), accessToken: String(issued?.accessToken)};
}

function proxied(
  url: string,
  session: string | undefined,
  headers: Record<string, string> = SPA_FETCH,
  method:
    'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' = 'GET',
) {
  return app.inject({
    method,
    url,
    headers,
    cookies: session === undefined ? {} : {[SESSION]: session},
  });
}

/** Requests OpenEMR's FHIR server saw after sign-in (discovery, JWKS and the token call are not FHIR reads). */
function fhirCalls(): FhirCall[] {
  return stub.fhirRequests;
}

function firstCall(): FhirCall {
  const call = stub.fhirRequests[0];
  if (call === undefined) throw new Error('OpenEMR received no FHIR request');
  return call;
}

function expectHeaders(response: LightMyRequestResponse): void {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(String(response.headers['content-security-policy'])).toContain(
    "connect-src 'self'",
  );
  expect(response.headers['strict-transport-security']).toMatch(/max-age=/);
  expect(response.headers['referrer-policy']).toBe('same-origin');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
}

/** The proxy's own log lines (one per request), parsed. */
function proxyLogs(): Record<string, unknown>[] {
  return logLines
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(entry => entry.msg === 'fhir proxy');
}

function upstreamTarget(call: FhirCall): {path: string; query: string[][]} {
  return {
    path: call.url.pathname,
    query: [...call.url.searchParams.entries()].sort(),
  };
}

describe('given a signed-in clinician and each allow-listed read (API-10…24)', () => {
  beforeEach(async () => {
    await start();
  });

  it.each([
    ['API-10', 'metadata'],
    [
      'API-11',
      'Patient?name=Smi&birthdate=eq1970-01-01&identifier=PT-000123&_count=20&_offset=0',
    ],
    ['API-11', 'Patient?name=Smi'],
    ['API-12', `Patient/${PATIENT_ID}`],
    ['API-13', `AllergyIntolerance?patient=${PATIENT_ID}`],
    ['API-14', `Condition?patient=${PATIENT_ID}&category=problem-list-item`],
    // Medications and Prescriptions alike: every intent, unfiltered, one shared row (rulings).
    ['API-15/16', `MedicationRequest?patient=${PATIENT_ID}`],
    ['API-17', `CareTeam?patient=${PATIENT_ID}`],
    ['API-17', `CareTeam?patient=${PATIENT_ID}&status=active`],
    ['API-18', `Practitioner/${PRACTITIONER_ID}`],
    ['API-18', `Practitioner?_id=${PRACTITIONER_ID},p-2,p-3`],
    ['API-19', `Organization/${ORGANIZATION_ID}`],
    ['API-20', `Encounter?patient=${PATIENT_ID}&date=ge2024-09-25`],
    [
      'API-21',
      `Observation?patient=${PATIENT_ID}&category=vital-signs&date=ge2025-09-25`,
    ],
    [
      'API-22',
      `Observation?patient=${PATIENT_ID}&category=laboratory&date=ge2025-09-25`,
    ],
    ['API-23', `Immunization?patient=${PATIENT_ID}`],
    ['API-24', `Appointment?patient=${PATIENT_ID}&date=ge2026-09-25`],
  ])(
    'when the app reads %s (%s), then exactly that read reaches OpenEMR’s FHIR base and its answer comes back',
    async (apiId, pathAndQuery) => {
      const {session} = await signIn();

      const response = await proxied(`/bff/fhir/${pathAndQuery}`, session);

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(
        /^application\/fhir\+json/,
      );
      expect(fhirCalls()).toHaveLength(1);
      const expected = new URL(`${FHIR_BASE}/${pathAndQuery}`);
      expect(upstreamTarget(firstCall())).toEqual({
        path: expected.pathname,
        query: [...expected.searchParams.entries()].sort(),
      });
      expect(proxyLogs().at(-1)).toMatchObject({
        method: 'GET',
        api: apiId,
        status: 200,
      });
    },
  );
});

describe('given a signed-in clinician and a request off the allow-list', () => {
  beforeEach(async () => {
    await start();
  });

  it.each([
    // Resources and operations the inventory does not list.
    '/bff/fhir/Binary/1',
    '/bff/fhir/DocumentReference?patient=p-1',
    `/bff/fhir/Patient/${PATIENT_ID}/$everything`,
    `/bff/fhir/Patient/${PATIENT_ID}/_history`,
    '/bff/fhir/Patient/$export',
    // BUG-9: read-by-id of an Encounter needs admin/super and is never called.
    '/bff/fhir/Encounter/enc-1',
    // Case is not folded: FHIR resource names are case-sensitive.
    `/bff/fhir/patient/${PATIENT_ID}`,
    '/bff/fhir/METADATA',
    // Traversal, raw and encoded.
    '/bff/fhir/Patient/..',
    '/bff/fhir/Patient/.',
    '/bff/fhir/../api/patient',
    '/bff/fhir/%2e%2e/api/patient',
    '/bff/fhir/Patient/%2e%2e',
    '/bff/fhir/Patient/..%2f..%2fapi%2fpatient',
    // Encoded and odd separators.
    '/bff/fhir/Patient%2fp-1',
    '/bff/fhir/Patient%2Fp-1',
    '/bff/fhir/Patient%5cp-1',
    '/bff/fhir/Patient;v=1/p-1',
    '/bff/fhir/Patient/%70-1',
    // Empty segments.
    '/bff/fhir//Patient/p-1',
    '/bff/fhir/Patient//p-1',
    '/bff/fhir/Patient/p-1/',
    '/bff/fhir/',
    // Ids that are not FHIR ids.
    `/bff/fhir/Patient/${'a'.repeat(65)}`,
    '/bff/fhir/Patient/p_1',
    // Required search parameters missing.
    '/bff/fhir/AllergyIntolerance',
    '/bff/fhir/Condition?patient=p-1',
    '/bff/fhir/MedicationRequest',
    '/bff/fhir/Observation?patient=p-1&category=vital-signs',
    '/bff/fhir/Observation?category=vital-signs&date=ge2025-09-25',
    // Fixed values that are not the inventory's.
    '/bff/fhir/Condition?patient=p-1&category=encounter-diagnosis',
    '/bff/fhir/MedicationRequest?patient=p-1&intent=proposal',
    '/bff/fhir/MedicationRequest?patient=p-1&intent=order&status=draft',
    '/bff/fhir/Observation?patient=p-1&category=social-history&date=ge2025-01-01',
    '/bff/fhir/Encounter?patient=p-1&date=le2024-01-01',
    '/bff/fhir/Encounter?patient=p-1&date=ge2024-1-1',
    // API-21 is the Vitals card's read and nothing wider: no code, paging or sort; one patient.
    '/bff/fhir/Observation?patient=p-1&category=vital-signs&date=ge2025-09-25&code=http://loinc.org|8867-4',
    '/bff/fhir/Observation?patient=p-1&category=vital-signs&date=ge2025-09-25&code=8867-4',
    '/bff/fhir/Observation?patient=p-1&category=vital-signs&date=ge2025-09-25&_count=50',
    '/bff/fhir/Observation?patient=p-1&category=vital-signs&date=ge2025-09-25&_sort=-date',
    '/bff/fhir/Observation?patient=p-1&patient=p-2&category=vital-signs&date=ge2025-09-25',
    '/bff/fhir/Observation?patient=p-1&category=vital-signs&category=laboratory&date=ge2025-09-25',
    '/bff/fhir/Observation?patient=p-1&category=vital-signs&date=ge2025-09-25&date=ge2020-01-01',
    '/bff/fhir/Observation?patient=p-1&category=vital-signs&date=le2025-09-25',
    '/bff/fhir/Observation?patient=p-1,p-2&category=vital-signs&date=ge2025-09-25',
    // Parameters the inventory does not list, or repeats, or empty values.
    '/bff/fhir/AllergyIntolerance?patient=p-1&_include=AllergyIntolerance:patient',
    '/bff/fhir/AllergyIntolerance?patient=p-1&_format=xml',
    '/bff/fhir/AllergyIntolerance?patient=p-1&_summary=count',
    '/bff/fhir/AllergyIntolerance?patient=p-1&patient=p-2',
    '/bff/fhir/AllergyIntolerance?patient=',
    '/bff/fhir/AllergyIntolerance?patient=../Patient',
    '/bff/fhir/AllergyIntolerance?patient=p-1%26_format%3Dxml',
    '/bff/fhir/metadata?_format=xml',
    `/bff/fhir/Patient/${PATIENT_ID}?_elements=name`,
    '/bff/fhir/Patient?name=%3Cscript%3E',
    '/bff/fhir/Patient?_count=0',
    '/bff/fhir/Practitioner?_id=a,,b',
    // API-22 is the Labs card's read and nothing wider: no code, and one patient.
    '/bff/fhir/Observation?patient=p-1&category=laboratory&date=ge2025-09-25&code=2345-7',
    '/bff/fhir/Observation?patient=p-1&patient=p-2&category=laboratory&date=ge2025-09-25',
    '/bff/fhir/Observation?category=laboratory&date=ge2025-09-25',
  ])(
    'when the app asks for %s, then it is a JSON 404 and OpenEMR is never contacted',
    async url => {
      const {session} = await signIn();
      const before = outbound.length;

      const response = await proxied(url, session);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({error: 'not_found'});
      expectHeaders(response);
      expect(outbound.slice(before)).toEqual([]);
      expect(fhirCalls()).toEqual([]);
    },
  );
});

describe('given the Medications and Prescriptions cards both read MedicationRequest?patient={id} (rulings)', () => {
  beforeEach(async () => {
    await start();
  });

  it('when the app reads MedicationRequest?patient={id} with no intent or status, then it is forwarded once, logged and counted as API-15/16', async () => {
    const {session} = await signIn();

    const response = await proxied(
      `/bff/fhir/MedicationRequest?patient=${PATIENT_ID}`,
      session,
    );

    expect(response.statusCode).toBe(200);
    expect(fhirCalls()).toHaveLength(1);
    expect(upstreamTarget(firstCall())).toEqual({
      path: new URL(`${FHIR_BASE}/MedicationRequest`).pathname,
      query: [['patient', PATIENT_ID]],
    });
    // The proxy cannot tell which card asked, so the log and the BUG-38 counters name both, never one.
    expect(proxyLogs().at(-1)).toMatchObject({api: 'API-15/16', status: 200});
    const byApi = metrics.snapshot().byApi as Record<string, unknown>;
    expect(byApi['API-15/16']).toEqual({ok: 1});
    expect(byApi['API-15']).toBeUndefined();
    expect(byApi['API-16']).toBeUndefined();
  });

  it.each([
    // The shared row is patient-only: the old intent-filtered forms are refused, since no card sends them.
    '/bff/fhir/MedicationRequest?patient=p-1&intent=plan',
    '/bff/fhir/MedicationRequest?patient=p-1&intent=plan&status=active',
    '/bff/fhir/MedicationRequest?patient=p-1&status=active',
    // API-16's old `intent=order` form: refused too — the Prescriptions card reads every intent.
    '/bff/fhir/MedicationRequest?patient=p-1&intent=order',
    '/bff/fhir/MedicationRequest?patient=p-1&intent=order&status=active',
    '/bff/fhir/MedicationRequest?intent=order&patient=p-1&status=completed',
    // A parameter on no row, with or without an intent.
    '/bff/fhir/MedicationRequest?patient=p-1&foo=1',
    '/bff/fhir/MedicationRequest?patient=p-1&intent=plan&foo=1',
    '/bff/fhir/MedicationRequest?patient=p-1&_count=500',
    '/bff/fhir/MedicationRequest?patient=p-1&_include=MedicationRequest:requester',
    // `patient` is still required, once, and a FHIR id.
    '/bff/fhir/MedicationRequest?patient=p-1&patient=p-2',
    '/bff/fhir/MedicationRequest?patient=',
    '/bff/fhir/MedicationRequest?patient=../Patient',
    '/bff/fhir/MedicationRequest?subject=Patient/p-1',
  ])(
    'when the app asks for %s, then it is a JSON 404 and OpenEMR is never contacted',
    async url => {
      const {session} = await signIn();
      const before = outbound.length;

      const response = await proxied(url, session);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({error: 'not_found'});
      expect(outbound.slice(before)).toEqual([]);
      expect(fhirCalls()).toEqual([]);
      expect(metrics.snapshot().byApi).toEqual({});
    },
  );
});

describe('given the headers a request arrives with', () => {
  beforeEach(async () => {
    await start();
  });

  it('when the client sends its own Authorization, cookies, forwarding and custom headers, then OpenEMR sees only the server-side bearer and Accept', async () => {
    const {session, accessToken} = await signIn();

    const response = await app.inject({
      method: 'GET',
      url: `/bff/fhir/Patient/${PATIENT_ID}`,
      headers: {
        ...SPA_FETCH,
        authorization: 'Bearer CLIENT-SUPPLIED-TOKEN',
        origin: PUBLIC_ORIGIN,
        referer: `${PUBLIC_ORIGIN}/patients/${PATIENT_ID}`,
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-host': 'evil.example.test',
        'x-custom': 'synthetic',
        'user-agent': 'SyntheticTablet/1.0',
        'if-none-match': '"abc"',
      },
      cookies: {[SESSION]: session, other: 'synthetic-cookie'},
    });

    expect(response.statusCode).toBe(200);
    const headers = firstCall().headers;
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(headers.get('accept')).toBe('application/fhir+json');
    for (const name of [
      'cookie',
      'origin',
      'referer',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-custom',
      'if-none-match',
      'sec-fetch-site',
    ]) {
      expect(headers.get(name), name).toBeNull();
    }
    expect(headers.get('user-agent')).not.toBe('SyntheticTablet/1.0');
  });

  it('when the client asks for plain JSON, then that Accept is forwarded; anything else becomes FHIR JSON', async () => {
    const {session} = await signIn();

    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session, {
      ...SPA_FETCH,
      accept: 'application/json',
    });
    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session, {
      ...SPA_FETCH,
      accept: 'text/html',
    });

    expect(fhirCalls().map(call => call.headers.get('accept'))).toEqual([
      'application/json',
      'application/fhir+json',
    ]);
  });

  it('when a client with no session sends a bearer token of its own, then it is 401 and nothing is forwarded', async () => {
    const response = await proxied(
      `/bff/fhir/Patient/${PATIENT_ID}`,
      undefined,
      {
        ...SPA_FETCH,
        authorization: 'Bearer CLIENT-SUPPLIED-TOKEN',
      },
    );

    expect(response.statusCode).toBe(401);
    expect(outbound).not.toContain(`${FHIR_BASE}/Patient/${PATIENT_ID}`);
    expect(fhirCalls()).toEqual([]);
  });
});

describe('given what OpenEMR answers (BUG-33)', () => {
  beforeEach(async () => {
    await start();
  });

  it.each([
    [
      400,
      {
        validationErrors: {patient: 'synthetic'},
        internalErrors: [],
        data: [],
      },
      'application/json',
    ],
    [
      404,
      {
        resourceType: 'OperationOutcome',
        issue: [{severity: 'error', code: 'not-found'}],
      },
      'application/fhir+json',
    ],
    [
      500,
      {
        resourceType: 'OperationOutcome',
        issue: [{severity: 'fatal', code: 'exception'}],
      },
      'application/fhir+json',
    ],
    [
      401,
      {
        resourceType: 'OperationOutcome',
        issue: [{severity: 'error', code: 'login'}],
      },
      'application/fhir+json',
    ],
    [
      403,
      {
        resourceType: 'OperationOutcome',
        issue: [{severity: 'error', code: 'forbidden'}],
      },
      'application/fhir+json',
    ],
  ])(
    'when OpenEMR answers %s, then that status and body pass through unchanged, with no-store and the security headers',
    async (status, body, contentType) => {
      stub.fhirResponder = () =>
        HttpResponse.json(body, {
          status,
          headers: {'content-type': contentType},
        });
      const {session} = await signIn();

      const response = await proxied(
        `/bff/fhir/AllergyIntolerance?patient=${PATIENT_ID}`,
        session,
      );

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(body);
      expect(response.headers['content-type']).toMatch(
        new RegExp(`^${contentType.replace('+', '\\+')}`),
      );
      expectHeaders(response);
    },
  );

  it('when OpenEMR sends cookies, caching, validators and other headers, then none of them reach the browser', async () => {
    stub.fhirResponder = call => {
      const answer = defaultFhirAnswer(call);
      const headers = new Headers(answer.headers);
      headers.append('set-cookie', 'OpenEMR=synthetic-php-session; Path=/');
      headers.set('cache-control', 'public, max-age=3600');
      headers.set('etag', '"v1"');
      headers.set('last-modified', 'Wed, 01 Jan 2025 00:00:00 GMT');
      headers.set('x-powered-by', 'PHP/8.2');
      headers.set('access-control-allow-origin', '*');
      headers.set('www-authenticate', 'Bearer realm="OpenEMR"');
      headers.set('content-security-policy', 'default-src *');
      return new Response(answer.body, {status: 200, headers});
    };
    const {session} = await signIn();

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(200);
    for (const name of [
      'set-cookie',
      'etag',
      'last-modified',
      'x-powered-by',
      'access-control-allow-origin',
      'www-authenticate',
    ]) {
      expect(response.headers[name], name).toBeUndefined();
    }
    expectHeaders(response);
    expect(String(response.headers['content-security-policy'])).toContain(
      "default-src 'self'",
    );
  });

  it('when OpenEMR answers with an HTML page, then it is passed as plain text, never rendered as HTML on this origin', async () => {
    stub.fhirResponder = () =>
      new HttpResponse('<html><script>alert(1)</script></html>', {
        status: 500,
        headers: {'content-type': 'text/html; charset=UTF-8'},
      });
    const {session} = await signIn();

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expectHeaders(response);
  });

  it('when OpenEMR redirects, then the redirect is not followed or passed on and the answer is a PHI-free 502', async () => {
    stub.fhirResponder = () =>
      new HttpResponse(null, {
        status: 302,
        headers: {location: 'https://elsewhere.example.test/collect'},
      });
    const {session, accessToken} = await signIn();

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({error: 'upstream_unavailable'});
    expect(response.headers.location).toBeUndefined();
    expect(outbound.some(url => url.includes('elsewhere'))).toBe(false);
    expect(response.body).not.toContain(accessToken);
    expectHeaders(response);
  });

  it('when OpenEMR cannot be reached, then it is a PHI-free 502', async () => {
    stub.fhirResponder = () => HttpResponse.error();
    const {session} = await signIn();

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({error: 'upstream_unavailable'});
    expectHeaders(response);
  });
});

describe('given a method other than GET', () => {
  beforeEach(async () => {
    await start();
  });

  it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)(
    'when %s reaches an allow-listed path, then it is 405 with Allow: GET and nothing is forwarded',
    async method => {
      const {session} = await signIn();

      const response = await proxied(
        `/bff/fhir/Patient/${PATIENT_ID}`,
        session,
        {...SPA_FETCH, 'content-type': 'application/fhir+json'},
        method,
      );

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe('GET');
      if (method !== 'HEAD') {
        expect(response.json()).toEqual({error: 'method_not_allowed'});
      }
      expectHeaders(response);
      expect(fhirCalls()).toEqual([]);
    },
  );
});

describe('given where the request comes from (FR-BFF-6 for a read)', () => {
  beforeEach(async () => {
    await start();
  });

  it.each(['cross-site', 'same-site', 'none'])(
    'when Sec-Fetch-Site is %s, then it is 403 and nothing is forwarded',
    async site => {
      const {session} = await signIn();

      const response = await proxied(
        `/bff/fhir/Patient/${PATIENT_ID}`,
        session,
        {
          ...SPA_FETCH,
          'sec-fetch-site': site,
        },
      );

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({error: 'forbidden'});
      expectHeaders(response);
      expect(fhirCalls()).toEqual([]);
    },
  );

  it('when a non-browser client sends no Sec-Fetch-Site (Bruno, curl), then the session cookie alone decides', async () => {
    const {session} = await signIn();

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session, {
      accept: 'application/fhir+json',
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('given no usable session', () => {
  it.each([
    ['no session cookie', undefined],
    ['a cookie of the wrong shape', 'not-an-id'],
    ['a well-formed id the server never issued', 'A'.repeat(43)],
  ])(
    'when a read arrives with %s, then it is 401 in the shape the app treats as session-over, and nothing is forwarded',
    async (_label, cookie) => {
      await start();

      const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, cookie);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({error: 'unauthenticated'});
      expectHeaders(response);
      expect(fhirCalls()).toEqual([]);
    },
  );

  it('when the session has been idle past the inactivity timeout (FR-AUTH-4), then it is 401 and nothing is forwarded', async () => {
    await start();
    const {session} = await signIn();

    now += 15 * 60 * 1000 + 1;
    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({error: 'unauthenticated'});
    expect(fhirCalls()).toEqual([]);
  });

  it('when a read is proxied, then it counts as activity and restarts the idle clock', async () => {
    await start();
    const {session} = await signIn();

    now += 10 * 60 * 1000;
    const first = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);
    now += 10 * 60 * 1000;
    const second = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    // 20 minutes after sign-in, but only 10 after the last read: still inside the 15-minute timeout.
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it('when the access token is inside its refresh margin, then the read goes out with the refreshed token, not the old one', async () => {
    await start({
      session: {
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        maxSessionMs: 10 * 60 * 60 * 1000,
      },
    });
    const {session, accessToken} = await signIn();

    now += 3590 * 1000;
    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(200);
    const bearer = firstCall().headers.get('authorization');
    expect(bearer).not.toBe(`Bearer ${accessToken}`);
    expect(
      stub.liveAccessTokens.has(String(bearer).slice('Bearer '.length)),
    ).toBe(true);
  });

  it('when the access-token seam yields no token, then it is 401, the seam saw only the session id, and nothing is forwarded', async () => {
    const accessToken: AccessTokenResolver = vi.fn(() =>
      Promise.resolve(undefined),
    );
    await start({}, {accessToken});
    const {session} = await signIn();

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(401);
    expect(accessToken).toHaveBeenCalledExactlyOnceWith(session);
    expect(fhirCalls()).toEqual([]);
  });

  it('when the session was signed out, then its cookie no longer reads anything', async () => {
    await start();
    const {session} = await signIn();
    await app.inject({
      method: 'POST',
      url: '/bff/logout',
      headers: OWN_FORM_POST,
      cookies: {[SESSION]: session},
      payload: '',
    });

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(401);
    expect(fhirCalls()).toEqual([]);
  });
});

describe('given slow FHIR (BUG-28)', () => {
  it('when OpenEMR takes longer than the per-call timeout, then it is a PHI-free 504 with the headers', async () => {
    await start({
      fhirProxy: {...testConfig(dist.dir).fhirProxy, timeoutMs: 50},
    });
    stub.fhirResponder = async call => {
      await delay(1000);
      return defaultFhirAnswer(call);
    };
    const {session} = await signIn();

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({error: 'upstream_timeout'});
    expectHeaders(response);
    expect(proxyLogs().at(-1)).toMatchObject({api: 'API-12', status: 504});
  });

  it('when OpenEMR answers within the timeout even if slowly, then the answer is passed through', async () => {
    await start({
      fhirProxy: {...testConfig(dist.dir).fhirProxy, timeoutMs: 2000},
    });
    stub.fhirResponder = async call => {
      await delay(100);
      return defaultFhirAnswer(call);
    };
    const {session} = await signIn();

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(200);
  });
});

describe('given the upstream concurrency cap (BUG-28)', () => {
  /** Holds every FHIR answer until released. */
  function holdAnswers(): () => void {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    stub.fhirResponder = async call => {
      await gate;
      return defaultFhirAnswer(call);
    };
    return release;
  }

  /**
   * The session lifecycle's resolver, counting the answers it has given: an answer, not a call begun, is what
   * says a read has passed its pre-queue check and holds its token.
   */
  function countedAccessToken(): {
    resolver: AccessTokenResolver;
    answered: () => number;
  } {
    let answered = 0;
    return {
      resolver: async id => {
        const token = await app.sessions.getAccessToken(id);
        answered += 1;
        return token;
      },
      answered: () => answered,
    };
  }

  it('when a dashboard fans out past the global cap, then no more than the cap are in flight and every read still completes', async () => {
    await start({
      fhirProxy: {
        ...testConfig(dist.dir).fhirProxy,
        maxConcurrent: 2,
        maxConcurrentPerSession: 2,
        timeoutMs: 5000,
      },
    });
    const {session} = await signIn();
    const release = holdAnswers();

    const reads = [
      `Patient/${PATIENT_ID}`,
      `AllergyIntolerance?patient=${PATIENT_ID}`,
      `Condition?patient=${PATIENT_ID}&category=problem-list-item`,
      `MedicationRequest?patient=${PATIENT_ID}`,
      `CareTeam?patient=${PATIENT_ID}`,
    ].map(path => proxied(`/bff/fhir/${path}`, session));
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(2);
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stub.fhirRequests).toHaveLength(2);

    release();
    const responses = await Promise.all(reads);

    expect(responses.map(r => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(stub.fhirInFlight.max).toBe(2);
    expect(stub.fhirRequests).toHaveLength(5);
  });

  it('when one session fills its own share, then another session’s read is not queued behind it', async () => {
    await start({
      fhirProxy: {
        ...testConfig(dist.dir).fhirProxy,
        maxConcurrent: 3,
        maxConcurrentPerSession: 2,
        timeoutMs: 5000,
      },
    });
    const busy = await signIn();
    const other = await signIn();
    const release = holdAnswers();

    const busyReads = [1, 2, 3, 4].map(() =>
      proxied(`/bff/fhir/Patient/${PATIENT_ID}`, busy.session),
    );
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(2);
    });
    const otherRead = proxied(`/bff/fhir/Patient/${PATIENT_ID}`, other.session);
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(3);
    });

    expect(
      stub.fhirRequests.map(call => call.headers.get('authorization')),
    ).toEqual([
      `Bearer ${busy.accessToken}`,
      `Bearer ${busy.accessToken}`,
      `Bearer ${other.accessToken}`,
    ]);
    release();
    await Promise.all([...busyReads, otherRead]);
    expect(stub.fhirInFlight.max).toBe(3);
  });

  it('when a read waits in the queue, then the wait counts toward its timeout: it is a 504 within one budget of arriving', async () => {
    const budget = 400;
    await start({
      fhirProxy: {
        ...testConfig(dist.dir).fhirProxy,
        maxConcurrent: 1,
        maxConcurrentPerSession: 1,
        timeoutMs: budget,
      },
    });
    const {session} = await signIn();
    const release = holdAnswers();

    const first = proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(1);
    });
    const arrived = performance.now();
    const second = await proxied(
      `/bff/fhir/CareTeam?patient=${PATIENT_ID}`,
      session,
    );
    const waited = performance.now() - arrived;

    expect(second.statusCode).toBe(504);
    expect(second.json()).toEqual({error: 'upstream_timeout'});
    // Queue wait and upstream time share one budget; separate budgets would take about twice as long.
    expect(waited).toBeLessThan(budget * 1.5);
    release();
    expect((await first).statusCode).toBe(504);
  });

  it('when a read waits in the queue longer than the refresh margin under a raised budget, then it goes out with a token refreshed after the wait, not the one it had on arrival', async () => {
    const tokens = countedAccessToken();
    await start(
      {
        fhirProxy: {
          ...testConfig(dist.dir).fhirProxy,
          maxConcurrent: 1,
          maxConcurrentPerSession: 1,
          timeoutMs: 120_000,
        },
        session: {
          idleTimeoutMs: 2 * 60 * 60 * 1000,
          maxSessionMs: 10 * 60 * 60 * 1000,
        },
      },
      {accessToken: tokens.resolver},
    );
    const {session, accessToken} = await signIn();
    const release = holdAnswers();

    // 61 s of life left: outside the 60 s refresh margin, so the token is handed out as it is.
    now += (3600 - 61) * 1000;
    const first = proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(1);
    });
    const answered = tokens.answered();
    const second = proxied(`/bff/fhir/CareTeam?patient=${PATIENT_ID}`, session);
    // Its pre-queue check has answered, with the arrival token, before the clock moves.
    await vi.waitFor(() => {
      expect(tokens.answered()).toBe(answered + 1);
    });
    // It waits 70 s for the slot: the token it arrived with has 9 s left by then.
    now += 70 * 1000;
    release();
    const responses = await Promise.all([first, second]);

    expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
    const bearers = stub.fhirRequests.map(call =>
      call.headers.get('authorization'),
    );
    expect(bearers[0]).toBe(`Bearer ${accessToken}`);
    expect(bearers[1]).not.toBe(`Bearer ${accessToken}`);
    expect(
      stub.liveAccessTokens.has(String(bearers[1]).slice('Bearer '.length)),
    ).toBe(true);
    expect(
      stub.tokenRequests.filter(b => b.get('grant_type') === 'refresh_token'),
    ).toHaveLength(1);
  });

  it('when the session is signed out while a read waits in the queue, then that read is 401, nothing more is forwarded and the slot is freed', async () => {
    const tokens = countedAccessToken();
    await start(
      {
        fhirProxy: {
          ...testConfig(dist.dir).fhirProxy,
          maxConcurrent: 1,
          maxConcurrentPerSession: 1,
          timeoutMs: 5000,
        },
      },
      {accessToken: tokens.resolver},
    );
    const {session} = await signIn();
    const other = await signIn();
    const release = holdAnswers();

    const first = proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(1);
    });
    const answered = tokens.answered();
    const waiting = proxied(
      `/bff/fhir/CareTeam?patient=${PATIENT_ID}`,
      session,
    );
    // Its pre-queue check has answered, so it is signed out while waiting, not before it queued.
    await vi.waitFor(() => {
      expect(tokens.answered()).toBe(answered + 1);
    });
    await app.inject({
      method: 'POST',
      url: '/bff/logout',
      headers: OWN_FORM_POST,
      cookies: {[SESSION]: session},
      payload: '',
    });
    release();

    expect((await first).statusCode).toBe(200);
    const response = await waiting;
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({error: 'unauthenticated'});
    expectHeaders(response);
    expect(stub.fhirRequests).toHaveLength(1);
    expect(metrics.snapshot().rejected).toMatchObject({no_session: 1});
    // The slot it held was given back: another clinician's read still goes through.
    const after = await proxied(
      `/bff/fhir/Patient/${PATIENT_ID}`,
      other.session,
    );
    expect(after.statusCode).toBe(200);
  });

  it('when the token check a read makes once it holds its slot throws, then that read is a 500 and the slot is still given back', async () => {
    const answersFor = new Map<string, number>();
    /** Sessions whose second answer — the one a read asks for once it holds its slot — throws. */
    const failsOnceQueued = new Set<string>();
    const accessToken: AccessTokenResolver = async id => {
      const answer = (answersFor.get(id) ?? 0) + 1;
      answersFor.set(id, answer);
      if (failsOnceQueued.has(id) && answer === 2) {
        throw new Error('synthetic resolver failure');
      }
      return app.sessions.getAccessToken(id);
    };
    await start(
      {
        fhirProxy: {
          ...testConfig(dist.dir).fhirProxy,
          maxConcurrent: 1,
          maxConcurrentPerSession: 1,
          // Short, so a slot never given back shows as a 504 well inside the test's own timeout.
          timeoutMs: 2000,
        },
      },
      {accessToken},
    );
    const failing = (await signIn()).session;
    failsOnceQueued.add(failing);
    const other = await signIn();
    const release = holdAnswers();

    const first = proxied(`/bff/fhir/Patient/${PATIENT_ID}`, other.session);
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(1);
    });
    const waiting = proxied(
      `/bff/fhir/CareTeam?patient=${PATIENT_ID}`,
      failing,
    );
    await vi.waitFor(() => {
      expect(answersFor.get(failing)).toBe(1);
    });
    release();

    expect((await first).statusCode).toBe(200);
    const response = await waiting;
    expect(answersFor.get(failing)).toBe(2);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({error: 'internal'});
    expect(stub.fhirRequests).toHaveLength(1);
    const after = await proxied(
      `/bff/fhir/Patient/${PATIENT_ID}`,
      other.session,
    );
    expect(after.statusCode).toBe(200);
  });
});

describe('given what the logs may carry (FR-BFF-5, NFR-SEC-6)', () => {
  beforeEach(async () => {
    await start();
  });

  it('when reads carry a patient id in the path, a name and MRN in the query and PHI in the body, then no log line carries any of them or the token', async () => {
    const {session, accessToken} = await signIn();
    const before = logLines.length;

    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);
    await proxied(
      `/bff/fhir/Patient?name=${PLANTED_NAME}&identifier=${PLANTED_MRN}`,
      session,
    );
    await proxied(`/bff/fhir/Patient/${PATIENT_ID}/_history`, session);
    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, undefined);
    stub.fhirResponder = () =>
      HttpResponse.json(
        {
          resourceType: 'OperationOutcome',
          issue: [{diagnostics: `No patient ${PLANTED_NAME} ${PLANTED_MRN}`}],
        },
        {status: 500},
      );
    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    const logged = logLines.slice(before).join('\n');
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [
      PATIENT_ID,
      PLANTED_NAME,
      PLANTED_MRN,
      accessToken,
      session,
      'identifier=',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('when a read is proxied, then its log line carries method, API-#, status and latency and nothing else', async () => {
    const {session} = await signIn();

    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    const line = proxyLogs().at(-1);
    expect(line).toBeDefined();
    const {level, time, pid, hostname, reqId, msg, ...fields} = line ?? {};
    expect({level, time, pid, hostname, reqId, msg}).toBeDefined();
    expect(Object.keys(fields).sort()).toEqual([
      'api',
      'latencyMs',
      'method',
      'status',
    ]);
    expect(fields).toMatchObject({method: 'GET', api: 'API-12', status: 200});
    expect(typeof fields.latencyMs).toBe('number');
  });
});

describe('given the BUG-38 counters', () => {
  beforeEach(async () => {
    await start();
  });

  it('when reads come back 401, 403, as an empty bundle and as data, then each is counted apart from errors, per API-#', async () => {
    const {session} = await signIn();
    const answers = new Map<string, Response>([
      [
        'AllergyIntolerance',
        HttpResponse.json({resourceType: 'OperationOutcome'}, {status: 401}),
      ],
      [
        'Practitioner',
        HttpResponse.json({resourceType: 'OperationOutcome'}, {status: 403}),
      ],
      [
        'Condition',
        HttpResponse.json(
          {resourceType: 'Bundle', type: 'collection', total: 0},
          {headers: {'content-type': 'application/fhir+json'}},
        ),
      ],
      [
        'CareTeam',
        HttpResponse.json(
          {resourceType: 'Bundle', type: 'collection', total: 0, entry: []},
          {headers: {'content-type': 'application/fhir+json'}},
        ),
      ],
      [
        'Encounter',
        HttpResponse.json({resourceType: 'OperationOutcome'}, {status: 500}),
      ],
    ]);
    stub.fhirResponder = call => {
      const type = call.url.pathname.split('/').at(4) ?? '';
      return answers.get(type)?.clone() ?? defaultFhirAnswer(call);
    };

    await proxied(
      `/bff/fhir/AllergyIntolerance?patient=${PATIENT_ID}`,
      session,
    );
    await proxied(`/bff/fhir/Practitioner/${PRACTITIONER_ID}`, session);
    await proxied(
      `/bff/fhir/Condition?patient=${PATIENT_ID}&category=problem-list-item`,
      session,
    );
    await proxied(`/bff/fhir/CareTeam?patient=${PATIENT_ID}`, session);
    await proxied(
      `/bff/fhir/Encounter?patient=${PATIENT_ID}&date=ge2024-09-25`,
      session,
    );
    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);
    await proxied('/bff/fhir/Binary/1', session);
    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, undefined);

    const snapshot = metrics.snapshot();
    expect(snapshot.byApi['API-13']).toMatchObject({unauthorized: 1});
    expect(snapshot.byApi['API-18']).toMatchObject({forbidden: 1});
    expect(snapshot.byApi['API-14']).toMatchObject({empty_bundle: 1});
    expect(snapshot.byApi['API-17']).toMatchObject({empty_bundle: 1});
    expect(snapshot.byApi['API-20']).toMatchObject({server_error: 1});
    expect(snapshot.byApi['API-12']).toMatchObject({ok: 1});
    expect(snapshot.byApi['API-12']?.unauthorized ?? 0).toBe(0);
    expect(snapshot.byApi['API-14']?.ok ?? 0).toBe(0);
    expect(snapshot.rejected).toMatchObject({
      not_allow_listed: 1,
      no_session: 1,
    });
  });

  it('when a read by id succeeds, then it is never counted as an empty bundle', async () => {
    const {session} = await signIn();

    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(metrics.snapshot().byApi['API-12']).toMatchObject({ok: 1});
    expect(metrics.snapshot().byApi['API-12']?.empty_bundle ?? 0).toBe(0);
  });
});

/** Holds every FHIR answer until released. */
function holdEveryAnswer(): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  stub.fhirResponder = async call => {
    await gate;
    return defaultFhirAnswer(call);
  };
  return release;
}

describe('given a full upstream queue (BUG-28)', () => {
  it('when every slot is taken and the queue is full, then a further read is a PHI-free 503 at once and never reaches OpenEMR', async () => {
    await start(
      {
        fhirProxy: {
          ...testConfig(dist.dir).fhirProxy,
          maxConcurrent: 1,
          maxConcurrentPerSession: 1,
          timeoutMs: 5000,
        },
      },
      {fhirQueue: {maxQueued: 2, maxQueuedPerSession: 2}},
    );
    const busy = await signIn();
    const other = await signIn();
    const release = holdEveryAnswer();

    const held = [1, 2, 3].map(() =>
      proxied(`/bff/fhir/Patient/${PATIENT_ID}`, busy.session),
    );
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(1);
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const refused = await proxied(
      `/bff/fhir/Patient/${PATIENT_ID}`,
      other.session,
    );

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({error: 'busy'});
    expectHeaders(refused);
    expect(stub.fhirRequests).toHaveLength(1);
    release();
    expect((await Promise.all(held)).map(r => r.statusCode)).toEqual([
      200, 200, 200,
    ]);
    expect(metrics.snapshot().byApi['API-12']).toMatchObject({busy: 1});
  });
});

describe('given one session flooding the queue', () => {
  it('when it has 32 reads waiting by default, then that is its whole share of the 256-entry queue', async () => {
    await start();
    expect(DEFAULT_QUEUE_LIMITS).toEqual({
      maxQueued: 256,
      maxQueuedPerSession: 32,
    });
  });

  it('when one session fills its share of the queue, then its next read is 503 but another clinician’s read still queues and completes', async () => {
    await start(
      {
        fhirProxy: {
          ...testConfig(dist.dir).fhirProxy,
          maxConcurrent: 1,
          maxConcurrentPerSession: 1,
          timeoutMs: 5000,
        },
      },
      {fhirQueue: {maxQueued: 10, maxQueuedPerSession: 2}},
    );
    const busy = await signIn();
    const other = await signIn();
    const release = holdEveryAnswer();

    const held = [1, 2, 3].map(() =>
      proxied(`/bff/fhir/Patient/${PATIENT_ID}`, busy.session),
    );
    await vi.waitFor(() => {
      expect(stub.fhirInFlight.now).toBe(1);
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const refused = await proxied(
      `/bff/fhir/Patient/${PATIENT_ID}`,
      busy.session,
    );
    const otherRead = proxied(`/bff/fhir/Patient/${PATIENT_ID}`, other.session);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({error: 'busy'});
    release();
    expect((await otherRead).statusCode).toBe(200);
    expect((await Promise.all(held)).map(r => r.statusCode)).toEqual([
      200, 200, 200,
    ]);
  });
});

describe('given a large search answer (BUG-38 without the cost)', () => {
  it('when a search answer is larger than 64 KiB, then it passes through byte for byte and is never parsed for the empty-bundle count', async () => {
    await start();
    const {session} = await signIn();
    // Looks like an empty Bundle, but is padded past the parse limit: a real empty Bundle is a few hundred bytes.
    const body = `{"resourceType":"Bundle","type":"collection","entry":[]${' '.repeat(70 * 1024)}}`;
    stub.fhirResponder = () =>
      new Response(body, {
        status: 200,
        headers: {'content-type': 'application/fhir+json'},
      });
    const parse = vi.spyOn(JSON, 'parse');

    const response = await proxied(
      `/bff/fhir/CareTeam?patient=${PATIENT_ID}`,
      session,
    );
    const bigParses = parse.mock.calls.filter(
      ([text]) => typeof text === 'string' && text.length > 64 * 1024,
    );
    parse.mockRestore();

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
    expect(bigParses).toEqual([]);
    expect(metrics.snapshot().byApi['API-17']).toEqual({ok: 1});
  });

  it('when a small search answer is an empty Bundle, then it is still counted as one', async () => {
    await start();
    const {session} = await signIn();
    stub.fhirResponder = () =>
      HttpResponse.json(
        {resourceType: 'Bundle', type: 'collection', total: 0},
        {headers: {'content-type': 'application/fhir+json'}},
      );

    await proxied(`/bff/fhir/CareTeam?patient=${PATIENT_ID}`, session);

    expect(metrics.snapshot().byApi['API-17']).toEqual({empty_bundle: 1});
  });
});

describe('given an absolute-form request target (RFC 9112 §3.2.2)', () => {
  it('when a hand-built request names the full URL, then the log shows the redacted path and none of the ids or query', async () => {
    await start();
    await app.listen({port: 0, host: '127.0.0.1'});
    const {port} = app.server.address() as AddressInfo;
    const before = logLines.length;
    const target = `${PUBLIC_ORIGIN}/bff/fhir/Patient/${PATIENT_ID}?name=${PLANTED_NAME}`;

    const raw = await new Promise<string>((resolve, reject) => {
      let received = '';
      const socket = net.connect(port, '127.0.0.1', () =>
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: frontend.example.test\r\nConnection: close\r\n\r\n`,
        ),
      );
      socket.setEncoding('utf8');
      socket.on('data', chunk => (received += String(chunk)));
      socket.on('close', () => {
        resolve(received);
      });
      socket.on('error', reject);
    });

    expect(raw).toMatch(/^HTTP\/1\.1 \d{3}/);
    const logged = logLines.slice(before).join('\n');
    expect(logged).toContain('/bff/fhir/{path}');
    expect(logged).not.toContain(PATIENT_ID);
    expect(logged).not.toContain(PLANTED_NAME);
    expect(logged).not.toContain('frontend.example.test/bff/fhir');
  });
});

describe('given an answer larger than the 16 MiB cap (FR-BFF-5)', () => {
  it('when OpenEMR streams more than the cap, then it is a PHI-free 502 and no more than the cap plus 2 MiB (two 1 MiB chunks) is ever read', async () => {
    await start();
    const {session} = await signIn();
    const chunk = new TextEncoder().encode(
      `${PLANTED_NAME} ${PLANTED_MRN} `.padEnd(1024 * 1024, 'x'),
    );
    const total = MAX_BODY_BYTES * 3;
    let pulled = 0;
    stub.fhirResponder = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (pulled >= total) {
                controller.close();
                return;
              }
              pulled += chunk.byteLength;
              controller.enqueue(chunk);
            },
          },
          {highWaterMark: 0},
        ),
        {status: 200, headers: {'content-type': 'application/fhir+json'}},
      );

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({error: 'upstream_unavailable'});
    expect(response.body).not.toContain(PLANTED_NAME);
    expectHeaders(response);
    // arrayBuffer() would drain all 48 MiB before any size check could run.
    expect(pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * chunk.byteLength);
    expect(metrics.snapshot().byApi['API-12']).toMatchObject({
      upstream_unavailable: 1,
    });
  }, 20_000);

  it('when the answer is exactly at the cap, then it passes through whole', async () => {
    await start();
    const {session} = await signIn();
    const body = `"${'x'.repeat(MAX_BODY_BYTES - 2)}"`;
    stub.fhirResponder = () =>
      new Response(body, {
        status: 200,
        headers: {'content-type': 'application/fhir+json'},
      });

    const response = await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(response.statusCode).toBe(200);
    expect(response.body.length).toBe(MAX_BODY_BYTES);
  });
});

describe('given the signed-in clinician’s own Practitioner (API-18)', () => {
  it('when the app reads it through the proxy, then OpenEMR sees that read like any other: recorded, with the server-side bearer', async () => {
    await start();
    const {session, accessToken} = await signIn();

    const response = await proxied(
      `/bff/fhir/Practitioner/${FHIR_USER_ID}`,
      session,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({resourceType: 'Practitioner'});
    expect(fhirCalls().map(call => call.url.pathname)).toEqual([
      new URL(FHIR_USER).pathname,
    ]);
    expect(firstCall().headers.get('authorization')).toBe(
      `Bearer ${accessToken}`,
    );
  });
});

describe('given nothing may be kept (FR-BFF-5)', () => {
  it('when OpenEMR sends the same read twice, then each is fetched again — nothing is served from a cache', async () => {
    await start();
    const {session} = await signIn();

    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);
    await proxied(`/bff/fhir/Patient/${PATIENT_ID}`, session);

    expect(fhirCalls()).toHaveLength(2);
  });
});
