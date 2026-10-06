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
import {rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {FastifyInstance, LightMyRequestResponse} from 'fastify';
import {HttpResponse, delay, http} from 'msw';
import {setupServer} from 'msw/node';
import {buildServer, clientErrorReason} from './server.js';
import {
  ASSET_PATH,
  DOTFILE_SENTINEL,
  ICON_BYTES,
  ICON_PATH,
  INDEX_HTML,
  MANIFEST_JSON,
  MANIFEST_PATH,
  OUTSIDE_SENTINEL,
  SIBLING_SENTINEL,
  SMART_CONFIGURATION,
  SMART_DISCOVERY_URL,
  UNHASHED_STATIC_PATH,
  makeSpaDist,
  testConfig,
} from './test/fixtures.js';

/**
 * Revalidate on every load, at the browser and at Railway's CDN: `no-cache` alone is not enough there,
 * because the edge caches static content types for its default TTL unless `max-age` says otherwise.
 * DEPLOYMENT.md "The frontend on Railway"
 */
const REVALIDATE = 'no-cache, max-age=0';
/**
 * The page itself is never stored anywhere: once sign-out has changed a cookie, Chromium will not restore it from
 * its back/forward cache (`response-cache-control-no-store`), and a deploy is still picked up at once. Defence in
 * depth under the SPA's own `pageshow` reload. A separate change, FR-AUTH-3
 */
const NO_STORE = 'no-store';

const openemr = setupServer();
let dist: Awaited<ReturnType<typeof makeSpaDist>>;
let app: FastifyInstance;

beforeAll(async () => {
  openemr.listen({onUnhandledRequest: 'error'});
  dist = await makeSpaDist();
});

afterEach(() => {
  openemr.resetHandlers();
});

afterAll(async () => {
  openemr.close();
  await dist.cleanup();
});

async function start(
  overrides: Parameters<typeof testConfig>[1] = {},
  extraRoutes?: (server: FastifyInstance) => void,
): Promise<FastifyInstance> {
  app = buildServer(testConfig(dist.dir, overrides));
  extraRoutes?.(app);
  await app.ready();
  return app;
}

afterEach(async () => {
  await app.close();
});

function smartDiscoveryAnswers(resolver: Parameters<typeof http.get>[1]) {
  openemr.use(http.get(SMART_DISCOVERY_URL, resolver));
}

/** Directive name → its sources, from a Content-Security-Policy header. */
function cspDirectives(
  response: LightMyRequestResponse,
): Map<string, string[]> {
  const header = response.headers['content-security-policy'];
  expect(typeof header).toBe('string');
  return new Map(
    String(header)
      .split(';')
      .map(directive => directive.trim().split(/\s+/))
      .filter(parts => parts[0] !== undefined && parts[0] !== '')
      .map(([name, ...sources]) => [String(name), sources]),
  );
}

function expectSecurityHeaders(response: LightMyRequestResponse): void {
  const csp = cspDirectives(response);
  expect(csp.get('default-src')).toEqual(["'self'"]);
  expect(csp.get('connect-src')).toEqual(["'self'"]);
  expect(csp.get('form-action')).toEqual([
    "'self'",
    'https://openemr.example.test',
  ]);
  expect(csp.get('script-src')).toEqual(["'self'"]);
  expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  expect(csp.get('object-src')).toEqual(["'none'"]);
  expect(csp.get('base-uri')).toEqual(["'self'"]);

  const hsts = String(response.headers['strict-transport-security']);
  const maxAge = /max-age=(\d+)/.exec(hsts)?.[1];
  expect(Number(maxAge)).toBeGreaterThanOrEqual(31_536_000);

  expect(response.headers['referrer-policy']).toBe('same-origin');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
}

describe('given the built SPA and the /bff/* routes on one origin', () => {
  beforeEach(async () => {
    await start();
  });

  it('when the app root is requested, then index.html is served and never stored', async () => {
    const response = await app.inject({method: 'GET', url: '/'});

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.body).toBe(INDEX_HTML);
    expect(response.headers['cache-control']).toBe(NO_STORE);
  });

  it('when index.html is requested by name, then it is never stored either', async () => {
    const response = await app.inject({method: 'GET', url: '/index.html'});

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
    expect(response.headers['cache-control']).toBe(NO_STORE);
  });

  it.each(['/', '/signed-out'])(
    'when HEAD %s is requested, then the page answers no-store as GET does',
    async url => {
      const response = await app.inject({method: 'HEAD', url});

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe(NO_STORE);
    },
  );

  it('when a build file outside assets/ is requested, then it is not fingerprinted, so neither the browser nor the edge keeps it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: UNHASHED_STATIC_PATH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(response.headers['cache-control']).toBe(REVALIDATE);
  });

  it('when a hashed build asset is requested, then it is served as long-lived and immutable', async () => {
    const response = await app.inject({method: 'GET', url: ASSET_PATH});

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it.each(['/signed-out', '/patients/1', '/signed-out?reason=idle'])(
    'when a client-side route such as %s is loaded directly, then the SPA shell answers it and is never stored',
    async url => {
      const response = await app.inject({method: 'GET', url});

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(INDEX_HTML);
      expect(response.headers['cache-control']).toBe(NO_STORE);
    },
  );

  it('when a missing file is requested, then it is a 404, not the SPA shell', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/assets/missing-0000.js',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toBe(INDEX_HTML);
  });

  it.each([
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/secret.txt',
    '/..%2fsecret.txt',
    '/..%5csecret.txt',
    '/..\\secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/../distsecret.txt',
    '/..%2fdistsecret.txt',
  ])(
    'when %s tries to climb out of the build folder, then the file beside it is never served',
    async url => {
      const response = await app.inject({method: 'GET', url});

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain(OUTSIDE_SENTINEL);
      expect(response.body).not.toContain(SIBLING_SENTINEL);
    },
  );

  it.each(['/.env', '/assets/../.env', '/%2eenv'])(
    'when a dotfile in the build folder is requested as %s, then it is a 404 and its content is never served',
    async url => {
      const response = await app.inject({method: 'GET', url});

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(DOTFILE_SENTINEL);
    },
  );

  it.each([
    ['GET', '/bff/unknown'],
    ['GET', '/bff'],
    ['GET', '/bff/'],
    // Under the FHIR proxy, a path off its allow-list is the same 404 (API-44).
    ['GET', '/bff/fhir/Binary/1'],
    ['POST', '/bff/health'],
    ['DELETE', '/bff/health'],
    // The namespace is decided on the decoded, case-folded first segment, so these never reach the SPA shell.
    ['GET', '/BFF/unknown'],
    ['GET', '/Bff/health'],
    ['GET', '/bff%2funknown'],
    ['GET', '/bff%2Funknown'],
    ['GET', '/%62ff/unknown'],
    ['GET', '/bff;x/unknown'],
    ['GET', '/bff;x'],
    ['GET', '//bff/unknown'],
    ['GET', '/bff%5cunknown'],
  ] as const)(
    'when %s %s is not a token-handler route, then it is a JSON 404 and never the SPA shell',
    async (method, url) => {
      const response = await app.inject({method, url});

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.json()).toEqual({error: 'not_found'});
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );
});

describe('given the PWA manifest and icons Vite copies from public/ (FR-PWA-1)', () => {
  beforeEach(async () => {
    await start();
  });

  /** A fetch directive's sources, falling back to default-src as the browser does. */
  function effectiveSources(
    response: LightMyRequestResponse,
    directive: string,
  ): string[] | undefined {
    const csp = cspDirectives(response);
    return csp.get(directive) ?? csp.get('default-src');
  }

  it('when the manifest is requested, then it is served as application/manifest+json with the security headers', async () => {
    const response = await app.inject({method: 'GET', url: MANIFEST_PATH});

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(
      /^application\/manifest\+json(;|$)/,
    );
    expect(response.body).toBe(MANIFEST_JSON);
    expect(response.headers['cache-control']).toBe(REVALIDATE);
    expectSecurityHeaders(response);
  });

  it('when an icon is requested, then it is served as image/png with the security headers', async () => {
    const response = await app.inject({method: 'GET', url: ICON_PATH});

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload.equals(ICON_BYTES)).toBe(true);
    expect(response.headers['cache-control']).toBe(REVALIDATE);
    expectSecurityHeaders(response);
  });

  it('when the page loads them, then the CSP lets the browser fetch the manifest and icons from its own origin only', async () => {
    const response = await app.inject({method: 'GET', url: '/'});

    expect(effectiveSources(response, 'manifest-src')).toEqual(["'self'"]);
    expect(effectiveSources(response, 'img-src')).toEqual(["'self'"]);
  });

  it('when a missing icon is requested, then it is a 404, not the SPA shell', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/icons/icon-1024.png',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toBe(INDEX_HTML);
  });

  // a separate change (FR-PWA-2, FR-PWA-3) — the service worker the SPA build writes to its root.
  it('when the service worker script is requested, then it is JavaScript that revalidates on every check, never immutable (guards a deploy the tablet never sees)', async () => {
    await writeFile(path.join(dist.dir, 'sw.js'), 'self.x = 1;');
    try {
      const response = await app.inject({method: 'GET', url: '/sw.js'});

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/javascript/);
      expect(response.headers['cache-control']).toBe(REVALIDATE);
      expectSecurityHeaders(response);
      // worker-src falls back to child-src, then script-src: registration needs 'self'.
      const csp = cspDirectives(response);
      expect(
        csp.get('worker-src') ?? csp.get('child-src') ?? csp.get('script-src'),
      ).toEqual(["'self'"]);
    } finally {
      await rm(path.join(dist.dir, 'sw.js'));
    }
  });
});

describe('given the liveness probe (API-45)', () => {
  it('when /bff/health is called, then it answers 200 with the build id, without contacting OpenEMR', async () => {
    await start({build: '3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c'});

    const response = await app.inject({method: 'GET', url: '/bff/health'});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      build: '3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c',
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('when the image was built without a commit id, then /bff/health says the build is unknown', async () => {
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/health'});

    expect(response.json()).toEqual({status: 'ok', build: 'unknown'});
  });
});

describe('given the readiness probe (API-45) and OpenEMR SMART discovery (API-2)', () => {
  it('when SMART discovery answers with a SMART configuration, then /bff/ready is 200', async () => {
    const seen: string[] = [];
    smartDiscoveryAnswers(({request}) => {
      seen.push(request.url);
      return HttpResponse.json(SMART_CONFIGURATION);
    });
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({status: 'ready'});
    expect(response.headers['cache-control']).toBe('no-store');
    // BUG-28: readiness must not hit the slow FHIR `metadata` endpoint.
    expect(seen).toEqual([SMART_DISCOVERY_URL]);
  });

  it('when OpenEMR is unreachable, then /bff/ready is 503 "unreachable"', async () => {
    smartDiscoveryAnswers(() => HttpResponse.error());
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      reason: 'unreachable',
    });
  });

  it('when SMART discovery answers 5xx, then /bff/ready is 503 "upstream_status" and does not relay the body', async () => {
    smartDiscoveryAnswers(() =>
      HttpResponse.text('synthetic upstream stack trace', {status: 502}),
    );
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      reason: 'upstream_status',
    });
    expect(response.body).not.toContain('synthetic upstream stack trace');
  });

  it('when a proxy answers 200 with something that is not a SMART configuration, then /bff/ready is 503 "invalid_discovery"', async () => {
    smartDiscoveryAnswers(() =>
      HttpResponse.html('<html><body>Maintenance</body></html>'),
    );
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      reason: 'invalid_discovery',
    });
  });

  it('when the JSON lacks the authorization and token endpoints, then /bff/ready is 503 "invalid_discovery"', async () => {
    smartDiscoveryAnswers(() => HttpResponse.json({issuer: 'synthetic'}));
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      reason: 'invalid_discovery',
    });
  });

  it('when SMART discovery hangs past the timeout, then /bff/ready is 503 "timeout"', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      smartDiscoveryAnswers(async () => {
        await delay('infinite');
        return HttpResponse.json(SMART_CONFIGURATION);
      });
      await start({readyTimeoutMs: 5000});

      const pending = app.inject({method: 'GET', url: '/bff/ready'});
      await vi.advanceTimersByTimeAsync(5000);
      const response = await pending;

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({status: 'not_ready', reason: 'timeout'});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('given any response the token handler sends (NFR-SEC-2, FR-BFF-6)', () => {
  it.each([
    ['the SPA shell', '/'],
    ['a build asset', ASSET_PATH],
    ['a client-side route', '/signed-out'],
    ['a missing file', '/missing.png'],
    ['the liveness probe', '/bff/health'],
    ['an unknown /bff/* path', '/bff/unknown'],
  ])(
    'when it is %s, then it carries CSP, HSTS, Referrer-Policy and nosniff',
    async (_, url) => {
      await start();

      expectSecurityHeaders(await app.inject({method: 'GET', url}));
    },
  );

  it('when readiness fails, then the 503 carries the headers too', async () => {
    smartDiscoveryAnswers(() => HttpResponse.error());
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(503);
    expectSecurityHeaders(response);
  });

  it('when a handler throws, then the 500 carries the headers and hides the error detail', async () => {
    await start({}, server => {
      server.get('/bff/test-throws', () => {
        throw new Error('synthetic internal detail /var/secret/path');
      });
    });

    const response = await app.inject({method: 'GET', url: '/bff/test-throws'});

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({error: 'internal'});
    expect(response.body).not.toContain('synthetic internal detail');
    expectSecurityHeaders(response);
  });

  it('when the URL is malformed, then the 400 carries the headers too', async () => {
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/%E0%A4%A'});

    expect(response.statusCode).toBe(400);
    expectSecurityHeaders(response);
  });

  it('when the authorize origin differs from the OpenEMR base URL, then form-action names the authorize origin', async () => {
    await start({authorizeOrigin: 'https://login.example.test'});

    const csp = cspDirectives(await app.inject({method: 'GET', url: '/'}));

    expect(csp.get('form-action')).toEqual([
      "'self'",
      'https://login.example.test',
    ]);
  });
});

/**
 * A 4xx names what was wrong with the request — malformed, too large, not found — and never repeats any of it.
 * a separate change (from the review), REQUIREMENTS.md NFR-SEC-6
 */
describe('given a request the token handler refuses with a 4xx', () => {
  const PLANTED = 'SYNTHETIC-ECHO-SENTINEL-7731';
  const SAME_ORIGIN_FORM = {
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded',
  };

  beforeEach(async () => {
    await start();
  });

  it('when the URL is malformed, then it is 400 "malformed_request" and the body repeats none of it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/bff/%E0%A4%A${PLANTED}?q=${PLANTED}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({error: 'malformed_request'});
    expect(response.body).not.toContain(PLANTED);
  });

  it('when a JSON body does not parse, then it is 400 "malformed_request" and the body repeats none of it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/login',
      headers: {
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      payload: `{"${PLANTED}":`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({error: 'malformed_request'});
    expect(response.body).not.toContain(PLANTED);
  });

  it('when a form body is over its limit, then it is 413 "too_large" and the body repeats none of it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/logout',
      headers: SAME_ORIGIN_FORM,
      payload: `reason=${PLANTED}${'x'.repeat(2048)}`,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({error: 'too_large'});
    expect(response.body).not.toContain(PLANTED);
    expectSecurityHeaders(response);
  });

  it('when a body has a type no route accepts, then it is 415 "unsupported_media_type" and the body repeats none of it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bff/logout',
      headers: {
        'sec-fetch-site': 'same-origin',
        'content-type': `text/${PLANTED}`,
      },
      payload: PLANTED,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({error: 'unsupported_media_type'});
    expect(response.body).not.toContain(PLANTED);
  });

  it('when a /bff/* path does not exist, then it is still 404 "not_found" and the body repeats none of it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/bff/${PLANTED}?q=${PLANTED}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({error: 'not_found'});
    expect(response.body).not.toContain(PLANTED);
  });
});

/**
 * The reason is a typed, closed mapping by status: every 4xx answered today (and 429) is named, and any other 4xx is
 * `client_error` with a warning logged — never `malformed_request`, which means 400 alone.
 */
describe('given the closed set of 4xx reasons', () => {
  it.each([
    [400, 'malformed_request'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [405, 'method_not_allowed'],
    [408, 'request_timeout'],
    [413, 'too_large'],
    [414, 'too_large'],
    [415, 'unsupported_media_type'],
    [429, 'too_many_requests'],
    [431, 'too_large'],
  ])('when the status is %i, then the reason is "%s"', (status, reason) => {
    expect(clientErrorReason(status)).toBe(reason);
  });

  it('when the status is any 4xx but 400, then the reason is never "malformed_request"', () => {
    const mislabelled = Array.from({length: 99}, (_, i) => 401 + i).filter(
      status => clientErrorReason(status) === 'malformed_request',
    );

    expect(mislabelled).toEqual([]);
  });

  it.each([409, 418, 422, 499])(
    'when the status is %i, which no path raises today, then the reason is the generic "client_error"',
    status => {
      expect(clientErrorReason(status)).toBe('client_error');
    },
  );

  describe('when a handler throws a 4xx', () => {
    const PLANTED = 'SYNTHETIC-ECHO-SENTINEL-2046';
    let logLines: string[];

    beforeEach(async () => {
      logLines = [];
      app = buildServer(testConfig(dist.dir, {logLevel: 'info'}), {
        logStream: {
          write: (line: string) => {
            logLines.push(line);
          },
        },
      });
      app.get('/bff/test-status/:status', request => {
        const {status} = request.params as {status: string};
        throw Object.assign(new Error(PLANTED), {statusCode: Number(status)});
      });
      await app.ready();
    });

    it.each([
      [401, 'unauthenticated'],
      [429, 'too_many_requests'],
      [418, 'client_error'],
    ])(
      'when it is %i, then the answer is {"error":"%s"} with the headers, and repeats none of the request',
      async (status, reason) => {
        const response = await app.inject({
          method: 'GET',
          url: `/bff/test-status/${String(status)}?q=${PLANTED}`,
        });

        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual({error: reason});
        expect(response.body).not.toContain(PLANTED);
        expectSecurityHeaders(response);
      },
    );

    it('when its status has no reason of its own, then a warning names the status, so the gap is not silent', async () => {
      await app.inject({method: 'GET', url: '/bff/test-status/418'});

      const warnings = logLines
        .map(line => JSON.parse(line) as {level: number; statusCode?: number})
        .filter(line => line.level === 40);
      expect(warnings).toEqual([expect.objectContaining({statusCode: 418})]);
    });

    it('when its status is listed, then nothing is logged as a warning', async () => {
      await app.inject({method: 'GET', url: '/bff/test-status/429'});

      const warnings = logLines
        .map(line => JSON.parse(line) as {level: number})
        .filter(line => line.level === 40);
      expect(warnings).toEqual([]);
    });
  });
});

/**
 * Query strings carry FHIR search parameters — patient ids, names, identifiers — so no log line may carry one,
 * through the real logger configuration at its most verbose level. reference: REQUIREMENTS.md NFR-SEC-6, FR-BFF-5
 */
describe('given what the logs may carry of a query string (NFR-SEC-6, FR-BFF-5)', () => {
  const PLANTED_ID = 'SYNTHETIC-PHI-PATIENT-0f3c';
  const PLANTED_NAME = 'Plantedname';
  const QUERY = `patient=${PLANTED_ID}&name=${PLANTED_NAME}&identifier=${PLANTED_ID}`;
  let logLines: string[];

  beforeEach(async () => {
    logLines = [];
    smartDiscoveryAnswers(() => HttpResponse.json(SMART_CONFIGURATION));
    app = buildServer(testConfig(dist.dir, {logLevel: 'trace'}), {
      logStream: {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    });
    app.get('/bff/test-throws', () => {
      throw new Error('synthetic internal failure');
    });
    await app.ready();
  });

  it.each([
    ['the SPA shell', '/'],
    ['a client-side route', '/signed-out'],
    ['a build asset', ASSET_PATH],
    ['a missing file', '/missing.png'],
    ['the liveness probe', '/bff/health'],
    ['the readiness probe', '/bff/ready'],
    ['an unknown /bff/* path', '/bff/unknown'],
    ['a FHIR search with no session', '/bff/fhir/AllergyIntolerance'],
    ['a FHIR search off the allow-list', '/bff/fhir/Patient'],
    ['the sign-in callback', '/bff/callback'],
    ['a malformed URL', '/bff/%E0%A4%A'],
    ['a handler that throws', '/bff/test-throws'],
    [
      'an absolute-form target',
      'http://frontend.example.test/bff/fhir/Patient',
    ],
  ])(
    'when %s is requested with FHIR search parameters in its query, then no log line carries any of them',
    async (_, target) => {
      await app.inject({method: 'GET', url: `${target}?${QUERY}`});

      const logged = logLines.join('\n');
      // Proves the logger was listening: the request itself was logged, by path.
      expect(logged).toContain('"path"');
      for (const planted of [
        PLANTED_ID,
        PLANTED_NAME,
        'patient=',
        'identifier=',
      ]) {
        expect(logged).not.toContain(planted);
      }
    },
  );
});

/**
 * The window is timed on the monotonic clock (`performance.now()`), never the wall clock: an NTP step or a manual
 * clock change must neither stretch a cached answer nor cut it short.
 */
describe('given the readiness probe is asked again and again (API-45)', () => {
  let wall: number;
  let monotonic: number;
  let upstreamCalls: number;

  async function startWithClock(): Promise<void> {
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    app = buildServer(testConfig(dist.dir), {now: () => wall});
    await app.ready();
  }

  beforeEach(() => {
    wall = Date.parse('2026-09-28T09:00:00Z');
    monotonic = 1_000;
    upstreamCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('when probes arrive within the cache window, then SMART discovery is fetched once and every probe gets the same answer', async () => {
    smartDiscoveryAnswers(() => {
      upstreamCalls += 1;
      return HttpResponse.json(SMART_CONFIGURATION);
    });
    await startWithClock();

    const first = await app.inject({method: 'GET', url: '/bff/ready'});
    monotonic += 4_999;
    const second = await app.inject({method: 'GET', url: '/bff/ready'});

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(second.json()).toEqual({status: 'ready'});
    expect(second.headers['cache-control']).toBe('no-store');
    expect(upstreamCalls).toBe(1);
  });

  it('when the cache window has passed, then the next probe asks SMART discovery again', async () => {
    smartDiscoveryAnswers(() => {
      upstreamCalls += 1;
      return HttpResponse.json(SMART_CONFIGURATION);
    });
    await startWithClock();

    await app.inject({method: 'GET', url: '/bff/ready'});
    monotonic += 5_000;
    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(200);
    expect(upstreamCalls).toBe(2);
  });

  it('when OpenEMR is down, then the failure is cached too, so a probe storm cannot hammer it, and recovery shows once the window passes', async () => {
    let up = false;
    smartDiscoveryAnswers(() => {
      upstreamCalls += 1;
      return up
        ? HttpResponse.json(SMART_CONFIGURATION)
        : HttpResponse.text('synthetic', {status: 502});
    });
    await startWithClock();

    const down = await app.inject({method: 'GET', url: '/bff/ready'});
    up = true;
    monotonic += 1_000;
    const stillCached = await app.inject({method: 'GET', url: '/bff/ready'});
    monotonic += 4_000;
    const recovered = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(down.json()).toEqual({
      status: 'not_ready',
      reason: 'upstream_status',
    });
    expect(stillCached.statusCode).toBe(503);
    expect(stillCached.json()).toEqual({
      status: 'not_ready',
      reason: 'upstream_status',
    });
    expect(recovered.statusCode).toBe(200);
    expect(upstreamCalls).toBe(2);
  });

  it('when the wall clock steps forward an hour inside the window, then the cached answer is still used', async () => {
    smartDiscoveryAnswers(() => {
      upstreamCalls += 1;
      return HttpResponse.json(SMART_CONFIGURATION);
    });
    await startWithClock();

    await app.inject({method: 'GET', url: '/bff/ready'});
    wall += 60 * 60 * 1000;
    monotonic += 1_000;
    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(200);
    expect(upstreamCalls).toBe(1);
  });

  it('when the wall clock steps back an hour, then the window still ends 5 s after the answer and is not stretched', async () => {
    smartDiscoveryAnswers(() => {
      upstreamCalls += 1;
      return HttpResponse.json(SMART_CONFIGURATION);
    });
    await startWithClock();

    await app.inject({method: 'GET', url: '/bff/ready'});
    wall -= 60 * 60 * 1000;
    monotonic += 5_000;
    const response = await app.inject({method: 'GET', url: '/bff/ready'});

    expect(response.statusCode).toBe(200);
    expect(upstreamCalls).toBe(2);
  });

  it('when many probes arrive while one check is still waiting on OpenEMR, then they share that one upstream call', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    smartDiscoveryAnswers(async () => {
      upstreamCalls += 1;
      await gate;
      return HttpResponse.json(SMART_CONFIGURATION);
    });
    await startWithClock();

    const pending = Array.from({length: 20}, () =>
      app.inject({method: 'GET', url: '/bff/ready'}),
    );
    await vi.waitFor(() => {
      expect(upstreamCalls).toBe(1);
    });
    release();
    const responses = await Promise.all(pending);

    expect(responses.map(response => response.statusCode)).toEqual(
      Array.from({length: 20}, () => 200),
    );
    expect(upstreamCalls).toBe(1);
  });
});

/**
 * `style-src` keeps `'unsafe-inline'` (the decision is in REQUIREMENTS.md NFR-SEC-2). What keeps that narrow is that
 * CSS cannot load anything from another origin: no `img-src`, `font-src`, `media-src` or `style-src-*` loosens
 * `default-src 'self'`, and scripts stay `'self'`.
 */
describe('given the CSP style-src decision (NFR-SEC-2)', () => {
  it('when any response is sent, then inline styles are the only relaxation and nothing CSS can load leaves the origin', async () => {
    await start();

    const csp = cspDirectives(await app.inject({method: 'GET', url: '/'}));

    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect([...csp.keys()].sort()).toEqual([
      'base-uri',
      'connect-src',
      'default-src',
      'form-action',
      'frame-ancestors',
      'object-src',
      'script-src',
      'style-src',
    ]);
  });
});
