import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {setupServer} from 'msw/node';
import {loadConfig} from './config.js';
import {
  DEFAULT_PRIVACY_GRACE_SECONDS,
  parsePatientApps,
  parsePrivacyGraceSeconds,
} from './runtime_config.js';
import {buildServer} from './server.js';
import {makeSpaDist, testConfig} from './test/fixtures.js';

// The SPA's per-environment settings, read from the token handler's own environment at start-up and served to the
// SPA at /bff/config, so one image runs in every environment. The rules are the ones the build-time
// VITE_* variables had: invalid or blank patient apps = no slot; the grace is whole seconds 0-900, default 60.
// reference: INTERFACES.md API-48 · REQUIREMENTS.md FR-APP-1, FR-UI-4, NFR-SEC-1

const AGENTFORGE =
  'https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient={patientId}';
/** A value planted in a bad setting: it must never reach a log line or a response. */
const SENTINEL = 'SYNTHETIC-SETTING-SENTINEL-51c0';

/** One case of the rule table the SPA's parser is tested against too (config/runtime-config-rules.json). */
interface RuleCase {
  readonly case: string;
  readonly accepted: boolean;
  readonly value: unknown;
  readonly expected?: unknown;
}

const SHARED_RULES = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../config/runtime-config-rules.json', import.meta.url),
    ),
    'utf8',
  ),
) as {patientApps: RuleCase[]; privacyGraceSeconds: RuleCase[]};

describe('given the rule table shared with the SPA (config/runtime-config-rules.json)', () => {
  it('when it is read, then it holds cases on both sides of each rule (guards an empty or unread table passing)', () => {
    for (const cases of [
      SHARED_RULES.patientApps,
      SHARED_RULES.privacyGraceSeconds,
    ]) {
      expect(cases.some(c => c.accepted)).toBe(true);
      expect(cases.some(c => !c.accepted)).toBe(true);
    }
  });

  it.each(SHARED_RULES.patientApps.map(c => [c.case, c] as const))(
    'when PATIENT_APPS is %s, then the token handler serves what the SPA would keep (guards a rule widened on one side only)',
    (_name, rule) => {
      const {apps, problem} = parsePatientApps(JSON.stringify(rule.value));
      if (rule.accepted) {
        expect(apps).toEqual(rule.expected ?? rule.value);
        expect(problem).toBeUndefined();
      } else {
        expect(apps).toEqual([]);
        expect(problem).toMatch(/\S/);
      }
    },
  );

  it.each(SHARED_RULES.privacyGraceSeconds.map(c => [c.case, c] as const))(
    'when PRIVACY_GRACE_SECONDS is %s, then the token handler serves a grace the SPA accepts, or the default (guards a cap raised on one side only locking everyone out)',
    (_name, rule) => {
      const {seconds, problem} = parsePrivacyGraceSeconds(String(rule.value));
      if (rule.accepted) {
        expect(seconds).toBe(rule.value);
        expect(problem).toBeUndefined();
      } else {
        expect(seconds).toBe(60);
        expect(problem).toMatch(/0 to 900/);
      }
    },
  );
});

describe('given PATIENT_APPS (FR-APP-1)', () => {
  it('when it is unset or blank, then there are no apps and nothing is reported', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(parsePatientApps(raw)).toEqual({apps: []});
    }
  });

  it('when it lists AgentForge, then the entry keeps its label, launch URL template and access hint', () => {
    const raw = JSON.stringify([
      {label: 'Launch AgentForge', url: AGENTFORGE, aclHint: 'patients/demo'},
    ]);

    expect(parsePatientApps(raw)).toEqual({
      apps: [
        {label: 'Launch AgentForge', url: AGENTFORGE, aclHint: 'patients/demo'},
      ],
    });
  });

  it('when a label or hint is padded, then it is trimmed; an entry with no hint has none', () => {
    const raw = JSON.stringify([
      {label: '  Launch AgentForge ', url: AGENTFORGE},
      {label: 'Other', url: AGENTFORGE, aclHint: ' patients/demo '},
    ]);

    expect(parsePatientApps(raw)).toEqual({
      apps: [
        {label: 'Launch AgentForge', url: AGENTFORGE},
        {label: 'Other', url: AGENTFORGE, aclHint: 'patients/demo'},
      ],
    });
  });

  it('when an entry targets a local development OpenEMR over plain http, then it is accepted', () => {
    const url = 'http://localhost:8300/launch.php?patient={patientId}';

    expect(parsePatientApps(JSON.stringify([{label: 'Dev', url}]))).toEqual({
      apps: [{label: 'Dev', url}],
    });
  });

  it.each([
    ['not JSON', `Launch AgentForge ${SENTINEL}`],
    ['not a list', JSON.stringify({label: SENTINEL, url: AGENTFORGE})],
    ['an entry with no label', JSON.stringify([{url: AGENTFORGE}])],
    [
      'an entry with a blank label',
      JSON.stringify([{label: '  ', url: AGENTFORGE}]),
    ],
    [
      'a label over 60 characters',
      JSON.stringify([{label: 'x'.repeat(61), url: AGENTFORGE}]),
    ],
    [
      'an access hint over 120 characters',
      JSON.stringify([
        {label: 'App', url: AGENTFORGE, aclHint: 'x'.repeat(121)},
      ]),
    ],
    [
      'a key the entry does not define',
      JSON.stringify([{label: 'App', url: AGENTFORGE, target: '_self'}]),
    ],
    [
      'more than 8 entries',
      JSON.stringify(
        Array.from({length: 9}, (_, n) => ({
          label: `App ${String(n)}`,
          url: AGENTFORGE,
        })),
      ),
    ],
    [
      'a URL with no {patientId} placeholder (the launch would not be for this patient)',
      JSON.stringify([
        {label: 'App', url: `https://openemr.example.test/${SENTINEL}`},
      ]),
    ],
    [
      'a javascript: URL',
      JSON.stringify([{label: 'App', url: 'javascript:alert({patientId})'}]),
    ],
    [
      'a relative URL',
      JSON.stringify([{label: 'App', url: '/launch.php?patient={patientId}'}]),
    ],
    [
      'plain http to a host other than localhost',
      JSON.stringify([
        {
          label: 'App',
          url: 'http://openemr.example.test/launch.php?patient={patientId}',
        },
      ]),
    ],
    [
      'credentials in the URL',
      JSON.stringify([
        {
          label: 'App',
          url: `https://user:${SENTINEL}@openemr.example.test/launch.php?patient={patientId}`,
        },
      ]),
    ],
    [
      'the placeholder in the host (the patient would pick the server)',
      JSON.stringify([
        {label: 'App', url: 'https://{patientId}.example.test/launch.php'},
      ]),
    ],
    [
      'one bad entry among good ones',
      JSON.stringify([
        {label: 'Launch AgentForge', url: AGENTFORGE},
        {label: 'Bad', url: 'javascript:void({patientId})'},
      ]),
    ],
  ])(
    'when it holds %s, then the whole list is refused (no slot) and the problem names the rule, never the value (guards a misconfigured launch)',
    (_case, raw) => {
      const {apps, problem} = parsePatientApps(raw);

      expect(apps).toEqual([]);
      expect(problem).toMatch(/\S/);
      expect(problem).not.toContain(SENTINEL);
      expect(problem).not.toContain('openemr.example.test');
    },
  );
});

describe('given PRIVACY_GRACE_SECONDS (FR-UI-4)', () => {
  it('when it is unset or blank, then the grace is the 60 s default and nothing is reported', () => {
    expect(DEFAULT_PRIVACY_GRACE_SECONDS).toBe(60);
    expect(parsePrivacyGraceSeconds(undefined)).toEqual({seconds: 60});
    expect(parsePrivacyGraceSeconds('')).toEqual({seconds: 60});
  });

  it.each([
    ['0', 0],
    ['30', 30],
    ['300', 300],
    ['900', 900],
  ])('when it is %s, then it is honoured', (raw, seconds) => {
    expect(parsePrivacyGraceSeconds(raw)).toEqual({seconds});
  });

  it.each(['901', '-1', '1.5', '60s', ' 60', 'sixty', '00000', SENTINEL])(
    'when it is %j, then the default 60 s is used and the problem names the rule, never the value (guards a mistyped grace widening the window PHI is only covered)',
    raw => {
      const {seconds, problem} = parsePrivacyGraceSeconds(raw);

      expect(seconds).toBe(60);
      expect(problem).toMatch(/0 to 900/);
      expect(problem).not.toContain(SENTINEL);
    },
  );
});

describe('given the start-up configuration', () => {
  let dist: Awaited<ReturnType<typeof makeSpaDist>>;

  beforeAll(async () => {
    dist = await makeSpaDist();
  });

  afterAll(async () => {
    await dist.cleanup();
  });

  const required = () => ({
    OPENEMR_BASE_URL: 'https://openemr.example.test',
    BFF_SPA_DIST_DIR: dist.dir,
    BFF_PUBLIC_ORIGIN: 'https://frontend.example.test',
    OAUTH_CLIENT_ID: 'synthetic-client-id',
    OAUTH_CLIENT_SECRET: 'SYNTHETIC-SECRET',
  });

  it('when PATIENT_APPS and PRIVACY_GRACE_SECONDS are set, then the SPA settings carry them and there is nothing to warn about', () => {
    const config = loadConfig({
      ...required(),
      PATIENT_APPS: JSON.stringify([
        {label: 'Launch AgentForge', url: AGENTFORGE},
      ]),
      PRIVACY_GRACE_SECONDS: '300',
    });

    expect(config.spa).toEqual({
      patientApps: [{label: 'Launch AgentForge', url: AGENTFORGE}],
      privacyGraceSeconds: 300,
    });
    expect(config.warnings).toEqual([]);
  });

  it('when both are invalid, then start-up still succeeds (a link list must not take the app down), with no slot, the 60 s default and one warning per variable naming it and its rule, never its value', () => {
    const config = loadConfig({
      ...required(),
      PATIENT_APPS: `[{"label":"${SENTINEL}"`,
      PRIVACY_GRACE_SECONDS: SENTINEL,
    });

    expect(config.spa).toEqual({patientApps: [], privacyGraceSeconds: 60});
    expect(config.warnings).toHaveLength(2);
    expect(config.warnings[0]).toMatch(/^PATIENT_APPS: /);
    expect(config.warnings[1]).toMatch(/^PRIVACY_GRACE_SECONDS: /);
    expect(config.warnings.join('\n')).not.toContain(SENTINEL);
  });

  it('when the old build-time names are set instead, then they are not read: no slot and the default grace (guards a half-migrated service)', () => {
    const config = loadConfig({
      ...required(),
      VITE_PATIENT_APPS: JSON.stringify([
        {label: 'Launch AgentForge', url: AGENTFORGE},
      ]),
      VITE_PRIVACY_GRACE_SECONDS: '300',
    });

    expect(config.spa).toEqual({patientApps: [], privacyGraceSeconds: 60});
  });
});

describe('given the runtime config route (API-48)', () => {
  const openemr = setupServer();
  let dist: Awaited<ReturnType<typeof makeSpaDist>>;
  let app: FastifyInstance;
  let logLines: string[];

  beforeAll(async () => {
    // Any call to OpenEMR fails the test: the route reads the environment only.
    openemr.listen({onUnhandledRequest: 'error'});
    dist = await makeSpaDist();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    openemr.close();
    await dist.cleanup();
  });

  async function start(
    overrides: Parameters<typeof testConfig>[1] = {},
  ): Promise<void> {
    logLines = [];
    app = buildServer(testConfig(dist.dir, overrides), {
      logStream: {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    });
    await app.ready();
  }

  it('when the SPA reads /bff/config, then it answers the configured apps and grace as JSON, with no cookie and without contacting OpenEMR', async () => {
    await start({
      spa: {
        patientApps: [
          {
            label: 'Launch AgentForge',
            url: AGENTFORGE,
            aclHint: 'patients/demo',
          },
        ],
        privacyGraceSeconds: 120,
      },
    });

    const response = await app.inject({method: 'GET', url: '/bff/config'});

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      patientApps: [
        {label: 'Launch AgentForge', url: AGENTFORGE, aclHint: 'patients/demo'},
      ],
      privacyGraceSeconds: 120,
    });
  });

  it('when nothing is configured, then it answers no apps and the 60 s default', async () => {
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/config'});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      patientApps: [],
      privacyGraceSeconds: 60,
    });
  });

  it('when it is answered, then it is never stored — not by the browser, the CDN or the service worker (guards a stale config outliving a variable change)', async () => {
    await start();

    const response = await app.inject({method: 'GET', url: '/bff/config'});

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain(
      "connect-src 'self'",
    );
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const)(
    'when it is called with %s, then it is 405 with Allow: GET',
    async method => {
      await start();

      const response = await app.inject({method, url: '/bff/config'});

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe('GET');
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it.each(['/BFF/config', '/bff%2fconfig', '/bff/config/x', '//bff/config'])(
    'when it is spelled %s, then it is a 404, never the config or the SPA shell',
    async url => {
      await start();

      const response = await app.inject({method: 'GET', url});

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('privacyGraceSeconds');
    },
  );

  it('when a setting was ignored at start-up, then the server logs a warning naming the variable and its rule, never the value', async () => {
    const config = loadConfig({
      OPENEMR_BASE_URL: 'https://openemr.example.test',
      BFF_SPA_DIST_DIR: dist.dir,
      BFF_PUBLIC_ORIGIN: 'https://frontend.example.test',
      OAUTH_CLIENT_ID: 'synthetic-client-id',
      OAUTH_CLIENT_SECRET: 'SYNTHETIC-SECRET',
      PATIENT_APPS: `not json ${SENTINEL}`,
    });
    logLines = [];
    app = buildServer(
      {...config, logLevel: 'warn'},
      {
        logStream: {
          write: (line: string) => {
            logLines.push(line);
          },
        },
      },
    );
    await app.ready();

    const warnings = logLines
      .map(line => JSON.parse(line) as {level: number; msg?: string})
      .filter(line => line.level === 40);
    expect(warnings).toHaveLength(1);
    expect(logLines.join('\n')).toContain('PATIENT_APPS');
    expect(logLines.join('\n')).not.toContain(SENTINEL);
  });

  it('when nothing was ignored, then no warning is logged', async () => {
    await start({logLevel: 'warn'});

    expect(logLines).toEqual([]);
  });
});
