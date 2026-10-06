import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {HttpResponse, delay, http} from 'msw';
import {setupServer} from 'msw/node';
import {DiscoveryError, createDiscovery, flattenScopes} from './discovery.js';
import {
  OPENID_DISCOVERY_URL,
  SMART_DISCOVERY_URL,
  testConfig,
} from './test/fixtures.js';
import {
  AUTHORIZE_URL,
  END_SESSION_URL,
  FHIR_BASE,
  JWKS_URL,
  OAUTH_BASE,
  REQUESTED_SCOPES,
  TOKEN_URL,
  openidConfiguration,
  smartConfiguration,
} from './test/stub_openemr.js';

const openemr = setupServer();
beforeAll(() => {
  openemr.listen({onUnhandledRequest: 'error'});
});
afterEach(() => {
  openemr.resetHandlers();
});
afterAll(() => {
  openemr.close();
});

function serve(
  smart: Record<string, unknown> = smartConfiguration(),
  openid: Record<string, unknown> = openidConfiguration(),
) {
  const counts = {smart: 0, openid: 0};
  openemr.use(
    http.get(SMART_DISCOVERY_URL, () => {
      counts.smart += 1;
      return HttpResponse.json(smart);
    }),
    http.get(OPENID_DISCOVERY_URL, () => {
      counts.openid += 1;
      return HttpResponse.json(openid);
    }),
  );
  return counts;
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DiscoveryError);
    return (error as DiscoveryError).reason;
  }
  throw new Error('expected discovery to fail');
}

describe('given OpenEMR SMART configuration (API-2) and OpenID discovery (API-1)', () => {
  it('when both are valid, then endpoints come from SMART, the aud is the SMART issuer (BUG-17), and the id_token issuer and end-session come from OpenID', async () => {
    serve();
    const discovery = createDiscovery(testConfig('unused'), {now: () => 0});

    expect(await discovery.get()).toEqual({
      authorizationEndpoint: AUTHORIZE_URL,
      tokenEndpoint: TOKEN_URL,
      jwksUri: JWKS_URL,
      audience: FHIR_BASE,
      issuer: OAUTH_BASE,
      endSessionEndpoint: END_SESSION_URL,
    });
  });

  it('when fetched twice within the hour, then OpenEMR is asked once; after it, again', async () => {
    const counts = serve();
    let now = 0;
    const discovery = createDiscovery(testConfig('unused'), {now: () => now});

    await discovery.get();
    await discovery.get();
    expect(counts).toEqual({smart: 1, openid: 1});

    now += 60 * 60 * 1000;
    await discovery.get();
    expect(counts).toEqual({smart: 2, openid: 2});
  });

  it('when a fetch fails, then the failure is not cached', async () => {
    serve();
    // Registered last, so it answers first — once.
    openemr.use(
      http.get(
        SMART_DISCOVERY_URL,
        () => new HttpResponse(null, {status: 503}),
        {
          once: true,
        },
      ),
    );
    const discovery = createDiscovery(testConfig('unused'), {now: () => 0});

    expect(await reasonOf(discovery.get())).toBe('upstream_status');
    await expect(discovery.get()).resolves.toMatchObject({
      tokenEndpoint: TOKEN_URL,
    });
  });

  it('when SMART lists scopes nested one array deep (BUG-42), then they are flattened before the check', () => {
    expect(flattenScopes([['openid', 'fhirUser'], 'api:fhir'])).toEqual([
      'openid',
      'fhirUser',
      'api:fhir',
    ]);
    expect(flattenScopes(['openid'])).toEqual(['openid']);
    expect(flattenScopes(undefined)).toBeUndefined();
    expect(flattenScopes('openid')).toBeUndefined();
  });

  it('when SMART does not support a scope the token handler requests (BUG-11), then sign-in is refused before any browser is sent to OpenEMR', async () => {
    const smart = smartConfiguration();
    smart.scopes_supported = [
      REQUESTED_SCOPES.filter(scope => scope !== 'user/Encounter.read'),
    ];
    serve(smart);

    expect(
      await reasonOf(
        createDiscovery(testConfig('unused'), {now: () => 0}).get(),
      ),
    ).toBe('scope_unsupported');
  });

  it.each([
    ['missing', undefined],
    ['an object', {openid: true}],
    ['a string', 'openid fhirUser'],
    ['a list with a non-string', [['openid', 7]]],
  ])(
    'when SMART scopes_supported is %s, then sign-in is refused rather than the BUG-11 check skipped',
    async (_, value) => {
      const smart = smartConfiguration();
      if (value === undefined)
        Reflect.deleteProperty(smart, 'scopes_supported');
      else smart.scopes_supported = value;
      serve(smart);

      expect(
        await reasonOf(
          createDiscovery(testConfig('unused'), {now: () => 0}).get(),
        ),
      ).toBe('invalid_discovery');
    },
  );

  it('when SMART does not offer S256 PKCE (BUG-16), then discovery is invalid', async () => {
    const smart = smartConfiguration();
    smart.code_challenge_methods_supported = ['plain'];
    serve(smart);

    expect(
      await reasonOf(
        createDiscovery(testConfig('unused'), {now: () => 0}).get(),
      ),
    ).toBe('invalid_discovery');
  });

  it('when the authorize endpoint is not on the CSP form-action origin, then discovery is refused (the browser would block the redirect)', async () => {
    const smart = smartConfiguration();
    smart.authorization_endpoint = 'https://elsewhere.example.test/authorize';
    serve(smart);

    expect(
      await reasonOf(
        createDiscovery(testConfig('unused'), {now: () => 0}).get(),
      ),
    ).toBe('origin_mismatch');
  });

  it('when the end-session endpoint is not on the authorize origin, then discovery is refused', async () => {
    const openid = openidConfiguration();
    openid.end_session_endpoint = 'https://elsewhere.example.test/logout';
    serve(smartConfiguration(), openid);

    expect(
      await reasonOf(
        createDiscovery(testConfig('unused'), {now: () => 0}).get(),
      ),
    ).toBe('origin_mismatch');
  });

  it.each([
    ['jwks_uri', 'smart'],
    ['token_endpoint', 'smart'],
    ['issuer', 'smart'],
    ['issuer', 'openid'],
    ['end_session_endpoint', 'openid'],
  ])(
    'when %s is missing from %s discovery, then discovery is invalid',
    async (field, document) => {
      const smart = smartConfiguration();
      const openid = openidConfiguration();
      Reflect.deleteProperty(document === 'smart' ? smart : openid, field);
      serve(smart, openid);

      expect(
        await reasonOf(
          createDiscovery(testConfig('unused'), {now: () => 0}).get(),
        ),
      ).toBe('invalid_discovery');
    },
  );

  it('when an endpoint is plain http on a non-loopback host, then discovery is invalid', async () => {
    const smart = smartConfiguration();
    smart.token_endpoint = 'http://openemr.example.test/oauth2/default/token';
    serve(smart);

    expect(
      await reasonOf(
        createDiscovery(testConfig('unused'), {now: () => 0}).get(),
      ),
    ).toBe('invalid_discovery');
  });

  it('when OpenEMR is unreachable, then the reason is "unreachable"', async () => {
    openemr.use(
      http.get(SMART_DISCOVERY_URL, () => HttpResponse.error()),
      http.get(OPENID_DISCOVERY_URL, () => HttpResponse.error()),
    );

    expect(
      await reasonOf(
        createDiscovery(testConfig('unused'), {now: () => 0}).get(),
      ),
    ).toBe('unreachable');
  });

  it('when discovery hangs past the OAuth timeout, then the reason is "timeout"', async () => {
    openemr.use(
      http.get(SMART_DISCOVERY_URL, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
      http.get(OPENID_DISCOVERY_URL, () =>
        HttpResponse.json(openidConfiguration()),
      ),
    );
    const base = testConfig('unused');
    const config = testConfig('unused', {
      oauth: {...base.oauth, timeoutMs: 50},
    });

    expect(await reasonOf(createDiscovery(config, {now: () => 0}).get())).toBe(
      'timeout',
    );
  });
});
