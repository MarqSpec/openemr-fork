import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspect} from 'node:util';
import {ConfigError, Secret, loadConfig} from './config.js';
import {makeSpaDist} from './test/fixtures.js';

let dist: Awaited<ReturnType<typeof makeSpaDist>>;
let emptyDir: string;

beforeAll(async () => {
  dist = await makeSpaDist();
  emptyDir = await mkdtemp(path.join(tmpdir(), 'bff-empty-'));
});

afterAll(async () => {
  await dist.cleanup();
  await rm(emptyDir, {recursive: true, force: true});
});

const SECRET = 'SYNTHETIC-SECRET-SENTINEL-9c3f';

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    OPENEMR_BASE_URL: 'https://openemr.example.test',
    BFF_SPA_DIST_DIR: dist.dir,
    BFF_PUBLIC_ORIGIN: 'https://frontend.example.test',
    OAUTH_CLIENT_ID: 'synthetic-client-id',
    OAUTH_CLIENT_SECRET: SECRET,
    ...overrides,
  };
}

/** Runs `loadConfig` expecting a failure and returns the start-up message. */
function failureOf(environment: Record<string, string | undefined>): string {
  try {
    loadConfig(environment);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('expected loadConfig to reject the environment');
}

describe('given a minimal valid environment', () => {
  it('when parsed, then the defaults fill everything else', () => {
    const config = loadConfig(env());

    expect(config).toEqual({
      port: 8080,
      host: '0.0.0.0',
      spaDistDir: path.resolve(dist.dir),
      smartDiscoveryUrl:
        'https://openemr.example.test/apis/default/fhir/.well-known/smart-configuration',
      openidDiscoveryUrl:
        'https://openemr.example.test/oauth2/default/.well-known/openid-configuration',
      authorizeOrigin: 'https://openemr.example.test',
      publicOrigin: 'https://frontend.example.test',
      cookieMode: 'host-prefixed',
      oauth: {
        clientId: 'synthetic-client-id',
        clientSecret: expect.any(Secret) as unknown,
        timeoutMs: 10_000,
      },
      readyTimeoutMs: 5000,
      fhirProxy: {
        baseUrl: 'https://openemr.example.test/apis/default/fhir',
        timeoutMs: 30_000,
        maxConcurrent: 4,
        maxConcurrentPerSession: 3,
      },
      logLevel: 'info',
      session: {
        idleTimeoutMs: 15 * 60 * 1000,
        maxSessionMs: 10 * 60 * 60 * 1000,
      },
      build: 'unknown',
    });
    expect(config.oauth.clientSecret.reveal()).toBe(SECRET);
  });

  it('when BUILD_SHA names the commit the image was built from, then it is kept as the build id', () => {
    const sha = '3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c';

    expect(loadConfig(env({BUILD_SHA: sha})).build).toBe(sha);
  });

  it('when BUILD_SHA is empty (an image built without the build arg), then the build is unknown', () => {
    expect(loadConfig(env({BUILD_SHA: ''})).build).toBe('unknown');
  });

  it('when OpenEMR lives under a path and another site, then SMART discovery (not metadata) is derived beneath both', () => {
    const config = loadConfig(
      env({
        OPENEMR_BASE_URL: 'https://clinic.example.test/openemr/',
        OPENEMR_SITE: 'clinic2',
      }),
    );

    expect(config.smartDiscoveryUrl).toBe(
      'https://clinic.example.test/openemr/apis/clinic2/fhir/.well-known/smart-configuration',
    );
    expect(config.smartDiscoveryUrl).not.toContain('metadata');
    expect(config.openidDiscoveryUrl).toBe(
      'https://clinic.example.test/openemr/oauth2/clinic2/.well-known/openid-configuration',
    );
    expect(config.authorizeOrigin).toBe('https://clinic.example.test');
  });

  it('when the browser reaches OpenEMR on another host than the token handler does, then the authorize origin is taken from OPENEMR_AUTHORIZE_ORIGIN', () => {
    const config = loadConfig(
      env({
        OPENEMR_BASE_URL: 'https://openemr.internal:8443',
        OPENEMR_AUTHORIZE_ORIGIN: 'https://login.example.test',
      }),
    );

    expect(config.authorizeOrigin).toBe('https://login.example.test');
  });

  it('when PORT, BFF_HOST, BFF_READY_TIMEOUT_MS and BFF_LOG_LEVEL are set, then they are honoured', () => {
    const config = loadConfig(
      env({
        PORT: '3000',
        BFF_HOST: '127.0.0.1',
        BFF_READY_TIMEOUT_MS: '2500',
        BFF_LOG_LEVEL: 'warn',
      }),
    );

    expect(config).toMatchObject({
      port: 3000,
      host: '127.0.0.1',
      readyTimeoutMs: 2500,
      logLevel: 'warn',
    });
  });

  it('when OpenEMR is plain http on loopback (the dev stack), then it is accepted', () => {
    const config = loadConfig(env({OPENEMR_BASE_URL: 'http://localhost:8300'}));

    expect(config.smartDiscoveryUrl).toBe(
      'http://localhost:8300/apis/default/fhir/.well-known/smart-configuration',
    );
  });
});

describe('given an invalid environment', () => {
  it('when the required variables are missing, then start-up fails naming every one of them at once', () => {
    const message = failureOf({});

    expect(message).toContain('OPENEMR_BASE_URL');
    expect(message).toContain('BFF_SPA_DIST_DIR');
    expect(message).toContain('BFF_PUBLIC_ORIGIN');
    expect(message).toContain('OAUTH_CLIENT_ID');
    expect(message).toContain('OAUTH_CLIENT_SECRET');
  });

  it.each(['abc', '0', '65536', '80.5', ''])(
    'when PORT is "%s", then start-up fails naming PORT',
    port => {
      expect(failureOf(env({PORT: port}))).toContain('PORT');
    },
  );

  it.each([
    ['not a URL', 'openemr.example.test'],
    ['plain http off loopback', 'http://openemr.example.test'],
    ['an unsupported scheme', 'ftp://openemr.example.test'],
    ['a query string', 'https://openemr.example.test/?site=default'],
  ])('when OPENEMR_BASE_URL is %s, then start-up fails naming it', (_, url) => {
    expect(failureOf(env({OPENEMR_BASE_URL: url}))).toContain(
      'OPENEMR_BASE_URL',
    );
  });

  it('when OPENEMR_BASE_URL embeds credentials, then start-up fails without echoing them', () => {
    const message = failureOf(
      env({
        OPENEMR_BASE_URL:
          'https://admin:hunter2-synthetic@openemr.example.test',
      }),
    );

    expect(message).toContain('OPENEMR_BASE_URL');
    expect(message).not.toContain('hunter2-synthetic');
    expect(message).not.toContain('admin:');
  });

  it('when a value is rejected, then the message names the rule, never the value', () => {
    const message = failureOf(env({BFF_LOG_LEVEL: 'synthetic-secret-value'}));

    expect(message).toContain('BFF_LOG_LEVEL');
    expect(message).not.toContain('synthetic-secret-value');
  });

  it.each([
    ['has a path', 'https://login.example.test/oauth2'],
    ['is plain http off loopback', 'http://login.example.test'],
    ['is not a URL', 'login.example.test'],
  ])(
    'when OPENEMR_AUTHORIZE_ORIGIN %s, then start-up fails naming it',
    (_, origin) => {
      expect(failureOf(env({OPENEMR_AUTHORIZE_ORIGIN: origin}))).toContain(
        'OPENEMR_AUTHORIZE_ORIGIN',
      );
    },
  );

  it.each(['main', 'not-a-sha', 'ABCDEF1', '3f9a1c', 'x'.repeat(41)])(
    'when BUILD_SHA is "%s" (not a lower-case hex commit id), then start-up fails naming it',
    sha => {
      expect(failureOf(env({BUILD_SHA: sha}))).toContain('BUILD_SHA');
    },
  );

  it.each(['../default', 'a/b', ''])(
    'when OPENEMR_SITE is "%s", then start-up fails naming it',
    site => {
      expect(failureOf(env({OPENEMR_SITE: site}))).toContain('OPENEMR_SITE');
    },
  );

  it('when BFF_SPA_DIST_DIR has no index.html (the SPA was not built), then start-up fails naming it', () => {
    expect(failureOf(env({BFF_SPA_DIST_DIR: emptyDir}))).toContain(
      'BFF_SPA_DIST_DIR',
    );
  });

  it('when BFF_SPA_DIST_DIR does not exist, then start-up fails naming it', () => {
    expect(
      failureOf(env({BFF_SPA_DIST_DIR: path.join(emptyDir, 'missing')})),
    ).toContain('BFF_SPA_DIST_DIR');
  });

  it.each(['0', '-1', '60001', 'soon'])(
    'when BFF_READY_TIMEOUT_MS is "%s", then start-up fails naming it',
    timeout => {
      expect(failureOf(env({BFF_READY_TIMEOUT_MS: timeout}))).toContain(
        'BFF_READY_TIMEOUT_MS',
      );
    },
  );
});

describe('given the session limits (FR-BFF-4, FR-AUTH-4, PRD Q-2)', () => {
  it('when unset, then the inactivity timeout is 15 minutes and the maximum session one clinic day, 10 hours', () => {
    expect(loadConfig(env()).session).toEqual({
      idleTimeoutMs: 900_000,
      maxSessionMs: 36_000_000,
    });
  });

  it('when BFF_IDLE_TIMEOUT_SECONDS and BFF_MAX_SESSION_SECONDS are set, then they are honoured', () => {
    const config = loadConfig(
      env({BFF_IDLE_TIMEOUT_SECONDS: '600', BFF_MAX_SESSION_SECONDS: '28800'}),
    );

    expect(config.session).toEqual({
      idleTimeoutMs: 600_000,
      maxSessionMs: 28_800_000,
    });
  });

  it.each([
    ['BFF_IDLE_TIMEOUT_SECONDS', '59'],
    ['BFF_IDLE_TIMEOUT_SECONDS', '3601'],
    ['BFF_IDLE_TIMEOUT_SECONDS', '15m'],
    ['BFF_MAX_SESSION_SECONDS', '299'],
    ['BFF_MAX_SESSION_SECONDS', '86401'],
    ['BFF_MAX_SESSION_SECONDS', '-1'],
  ])(
    'when %s is %s, then start-up fails naming it and its range',
    (name, value) => {
      const message = failureOf(env({[name]: value}));
      expect(message).toContain(`${name}: must be an integer from`);
    },
  );

  it('when the inactivity timeout is longer than the maximum session, then start-up fails naming both', () => {
    const message = failureOf(
      env({BFF_IDLE_TIMEOUT_SECONDS: '1800', BFF_MAX_SESSION_SECONDS: '900'}),
    );

    expect(message).toContain(
      'BFF_IDLE_TIMEOUT_SECONDS: must not exceed BFF_MAX_SESSION_SECONDS',
    );
  });
});

describe('given the OAuth client credentials (FR-BFF-2)', () => {
  it.each([
    ['empty', ''],
    ['whitespace-padded', ` ${SECRET} `],
    ['multi-line', `${SECRET}\nsecond-line`],
  ])(
    'when OAUTH_CLIENT_SECRET is %s, then start-up fails naming the variable and never echoing the value',
    (_, secret) => {
      const message = failureOf(env({OAUTH_CLIENT_SECRET: secret}));

      expect(message).toContain('OAUTH_CLIENT_SECRET');
      expect(message).not.toContain(SECRET);
    },
  );

  it.each([
    ['empty', ''],
    ['has whitespace', 'synthetic client'],
  ])('when OAUTH_CLIENT_ID is %s, then start-up fails naming it', (_, id) => {
    expect(failureOf(env({OAUTH_CLIENT_ID: id}))).toContain('OAUTH_CLIENT_ID');
  });

  it('when the parsed configuration is serialised or inspected (a log line, an error report), then the secret is redacted', () => {
    const config = loadConfig(env());

    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(inspect(config, {depth: 10})).not.toContain(SECRET);
    expect(String(config.oauth.clientSecret)).not.toContain(SECRET);
    expect(JSON.stringify({config})).toContain('[redacted]');
  });

  it.each(['1', '60000'])(
    'when BFF_OAUTH_TIMEOUT_MS is %s, then it is honoured',
    raw => {
      expect(loadConfig(env({BFF_OAUTH_TIMEOUT_MS: raw})).oauth.timeoutMs).toBe(
        Number(raw),
      );
    },
  );

  it.each(['0', '60001', 'soon'])(
    'when BFF_OAUTH_TIMEOUT_MS is "%s", then start-up fails naming it',
    timeout => {
      expect(failureOf(env({BFF_OAUTH_TIMEOUT_MS: timeout}))).toContain(
        'BFF_OAUTH_TIMEOUT_MS',
      );
    },
  );
});

describe('given the public origin and the cookie mode (FR-BFF-1)', () => {
  it('when the origin is https, then cookies are __Host- prefixed and Secure', () => {
    expect(loadConfig(env()).cookieMode).toBe('host-prefixed');
  });

  it.each([
    ['has a path', 'https://frontend.example.test/app'],
    ['has a trailing slash', 'https://frontend.example.test/'],
    ['is not a URL', 'frontend.example.test'],
    ['has a query', 'https://frontend.example.test?x=1'],
  ])(
    'when BFF_PUBLIC_ORIGIN %s, then start-up fails naming it',
    (_, origin) => {
      expect(failureOf(env({BFF_PUBLIC_ORIGIN: origin}))).toContain(
        'BFF_PUBLIC_ORIGIN',
      );
    },
  );

  it('when the origin is plain http off loopback, then start-up fails even with the development flag', () => {
    const message = failureOf(
      env({
        BFF_PUBLIC_ORIGIN: 'http://frontend.example.test',
        BFF_DEV_INSECURE_COOKIES: 'true',
      }),
    );

    expect(message).toContain('BFF_PUBLIC_ORIGIN');
  });

  it('when the origin is http://localhost without the development flag, then start-up fails naming the flag', () => {
    const message = failureOf(
      env({BFF_PUBLIC_ORIGIN: 'http://localhost:5173'}),
    );

    expect(message).toContain('BFF_DEV_INSECURE_COOKIES');
  });

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://[::1]:5173',
  ])(
    'when the origin is %s with BFF_DEV_INSECURE_COOKIES=true, then the development cookies are used',
    origin => {
      const config = loadConfig(
        env({BFF_PUBLIC_ORIGIN: origin, BFF_DEV_INSECURE_COOKIES: 'true'}),
      );

      expect(config.cookieMode).toBe('dev-insecure');
      expect(config.publicOrigin).toBe(origin);
    },
  );

  it('when a production (https) origin sets the development flag, then start-up refuses it', () => {
    const message = failureOf(env({BFF_DEV_INSECURE_COOKIES: 'true'}));

    expect(message).toContain('BFF_DEV_INSECURE_COOKIES');
  });

  it('when NODE_ENV is production, then the development flag is refused even on localhost', () => {
    const message = failureOf(
      env({
        BFF_PUBLIC_ORIGIN: 'http://localhost:5173',
        BFF_DEV_INSECURE_COOKIES: 'true',
        NODE_ENV: 'production',
      }),
    );

    expect(message).toContain('BFF_DEV_INSECURE_COOKIES');
  });

  it.each(['yes', '1', 'TRUE'])(
    'when BFF_DEV_INSECURE_COOKIES is "%s", then start-up fails: only true or false',
    flag => {
      expect(
        failureOf(
          env({
            BFF_PUBLIC_ORIGIN: 'http://localhost:5173',
            BFF_DEV_INSECURE_COOKIES: flag,
          }),
        ),
      ).toContain('BFF_DEV_INSECURE_COOKIES');
    },
  );

  it('when the flag is false on an https origin, then it is accepted', () => {
    expect(
      loadConfig(env({BFF_DEV_INSECURE_COOKIES: 'false'})).cookieMode,
    ).toBe('host-prefixed');
  });
});

describe('given the FHIR read proxy settings (FR-BFF-3, BUG-28)', () => {
  it('when OpenEMR lives under a path and another site, then the proxy base is that FHIR base, not one read from discovery', () => {
    const config = loadConfig(
      env({
        OPENEMR_BASE_URL: 'https://clinic.example.test/openemr/',
        OPENEMR_SITE: 'clinic2',
      }),
    );

    expect(config.fhirProxy.baseUrl).toBe(
      'https://clinic.example.test/openemr/apis/clinic2/fhir',
    );
  });

  it('when the timeout and both concurrency caps are set, then they are honoured', () => {
    const config = loadConfig(
      env({
        BFF_FHIR_TIMEOUT_MS: '45000',
        BFF_FHIR_MAX_CONCURRENT: '12',
        BFF_FHIR_MAX_CONCURRENT_PER_SESSION: '6',
      }),
    );

    expect(config.fhirProxy).toMatchObject({
      timeoutMs: 45_000,
      maxConcurrent: 12,
      maxConcurrentPerSession: 6,
    });
  });

  it.each([
    ['BFF_FHIR_TIMEOUT_MS', '0'],
    ['BFF_FHIR_TIMEOUT_MS', '120001'],
    ['BFF_FHIR_TIMEOUT_MS', 'slow'],
    ['BFF_FHIR_MAX_CONCURRENT', '0'],
    ['BFF_FHIR_MAX_CONCURRENT', '257'],
    ['BFF_FHIR_MAX_CONCURRENT_PER_SESSION', '0'],
    ['BFF_FHIR_MAX_CONCURRENT_PER_SESSION', 'many'],
  ])('when %s is %s, then start-up fails naming it', (variable, value) => {
    expect(failureOf(env({[variable]: value}))).toContain(variable);
  });

  it('when the per-session cap exceeds the global cap, then start-up fails naming the per-session cap', () => {
    const message = failureOf(
      env({
        BFF_FHIR_MAX_CONCURRENT: '2',
        BFF_FHIR_MAX_CONCURRENT_PER_SESSION: '3',
      }),
    );

    expect(message).toContain('BFF_FHIR_MAX_CONCURRENT_PER_SESSION');
  });
});
