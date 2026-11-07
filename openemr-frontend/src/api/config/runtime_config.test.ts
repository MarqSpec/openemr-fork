import {http, HttpResponse, type JsonBodyType} from 'msw';
import {describe, expect, it} from 'vitest';

import sharedRules from '../../../config/runtime-config-rules.json';
import {server} from '../../test/msw_server';
import {ApiError} from '../api_error';
import type {ApiFailure} from '../api_error';
import {readRuntimeConfig} from './runtime_config';

// The SPA's per-environment settings, read from the token handler at run time so one image runs in every
// environment. The rules are unchanged from the build-time VITE_* variables: an invalid patient-app list
// means no slot; the grace is whole seconds 0-900.
// reference: INTERFACES.md API-48 · REQUIREMENTS.md FR-APP-1, FR-UI-4, NFR-SEC-1

const CONFIG_URL = '/bff/config';
const AGENTFORGE =
  'https://openemr.example.test/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient={patientId}';

function answers(body: JsonBodyType, init?: ResponseInit) {
  server.use(http.get(CONFIG_URL, () => HttpResponse.json(body, init)));
}

/** One case of the rule table the token handler's parser is tested against too (config/runtime-config-rules.json). */
interface RuleCase {
  readonly case: string;
  readonly accepted: boolean;
  readonly value: JsonBodyType;
  readonly expected?: JsonBodyType;
}

// Imported, not read from disk: this suite runs in jsdom, whose import.meta.url is not a file URL.
const SHARED_RULES = sharedRules as unknown as {
  patientApps: RuleCase[];
  privacyGraceSeconds: RuleCase[];
};

async function failureOf(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.failure;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('given the runtime config read (API-48)', () => {
  it('when it is sent, then it is one same-origin GET to /bff/config with no Authorization header and nothing else asked', async () => {
    const seen: Request[] = [];
    server.use(
      http.get(CONFIG_URL, ({request}) => {
        seen.push(request);
        return HttpResponse.json({patientApps: [], privacyGraceSeconds: 60});
      }),
    );

    await readRuntimeConfig();

    expect(seen).toHaveLength(1);
    const request = seen[0];
    const url = new URL(request?.url ?? '');
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe(CONFIG_URL);
    expect(url.search).toBe('');
    expect(request?.method).toBe('GET');
    expect(request?.credentials).toBe('same-origin');
    expect(request?.headers.get('Authorization')).toBeNull();
  });

  it('when the token handler names AgentForge and a 5-minute grace, then both are returned as configured', async () => {
    answers({
      patientApps: [
        {label: 'Launch AgentForge', url: AGENTFORGE, aclHint: 'patients/demo'},
      ],
      privacyGraceSeconds: 300,
    });

    await expect(readRuntimeConfig()).resolves.toEqual({
      patientApps: [
        {label: 'Launch AgentForge', url: AGENTFORGE, aclHint: 'patients/demo'},
      ],
      privacyGraceSeconds: 300,
    });
  });

  it('when an app has no access hint, then it is still an app, without one', async () => {
    answers({
      patientApps: [{label: 'Launch AgentForge', url: AGENTFORGE}],
      privacyGraceSeconds: 60,
    });

    expect((await readRuntimeConfig()).patientApps).toEqual([
      {label: 'Launch AgentForge', url: AGENTFORGE},
    ]);
  });

  it('when an app targets a local development OpenEMR over plain http, then it is accepted', async () => {
    const url = 'http://localhost:8300/launch.php?patient={patientId}';
    answers({patientApps: [{label: 'Dev', url}], privacyGraceSeconds: 60});

    expect((await readRuntimeConfig()).patientApps).toEqual([
      {label: 'Dev', url},
    ]);
  });

  it.each([
    ['not a list', {label: 'Launch AgentForge', url: AGENTFORGE}],
    ['an entry with no label', [{url: AGENTFORGE}]],
    ['an entry with a blank label', [{label: '  ', url: AGENTFORGE}]],
    ['a label over 60 characters', [{label: 'x'.repeat(61), url: AGENTFORGE}]],
    [
      'an access hint over 120 characters',
      [{label: 'App', url: AGENTFORGE, aclHint: 'x'.repeat(121)}],
    ],
    [
      'a key the entry does not define',
      [{label: 'App', url: AGENTFORGE, target: '_self'}],
    ],
    [
      'more than 8 entries',
      Array.from({length: 9}, (_, n) => ({
        label: `App ${String(n)}`,
        url: AGENTFORGE,
      })),
    ],
    [
      'a URL with no {patientId} placeholder (the launch would not be for this patient)',
      [{label: 'App', url: 'https://openemr.example.test/launch.php'}],
    ],
    [
      'a javascript: URL',
      [{label: 'App', url: 'javascript:alert({patientId})'}],
    ],
    [
      'a relative URL',
      [{label: 'App', url: '/launch.php?patient={patientId}'}],
    ],
    [
      'plain http to a host other than localhost',
      [
        {
          label: 'App',
          url: 'http://openemr.example.test/launch.php?patient={patientId}',
        },
      ],
    ],
    [
      'credentials in the URL',
      [
        {
          label: 'App',
          url: 'https://user:pw@openemr.example.test/launch.php?patient={patientId}',
        },
      ],
    ],
    [
      'the placeholder in the host (the patient would pick the server)',
      [{label: 'App', url: 'https://{patientId}.example.test/launch.php'}],
    ],
    [
      'one bad entry among good ones',
      [
        {label: 'Launch AgentForge', url: AGENTFORGE},
        {label: 'Bad', url: 'javascript:void({patientId})'},
      ],
    ],
  ])(
    'when the app list holds %s, then the whole list is refused and no slot renders, but the grace still counts (guards a misconfigured launch, and a bad link list blocking the privacy screen)',
    async (_case, patientApps) => {
      answers({patientApps, privacyGraceSeconds: 15});

      await expect(readRuntimeConfig()).resolves.toEqual({
        patientApps: [],
        privacyGraceSeconds: 15,
      });
    },
  );

  it.each([
    ['missing', {patientApps: []}],
    ['above 900', {patientApps: [], privacyGraceSeconds: 901}],
    ['negative', {patientApps: [], privacyGraceSeconds: -1}],
    ['fractional', {patientApps: [], privacyGraceSeconds: 1.5}],
    ['a string', {patientApps: [], privacyGraceSeconds: '60'}],
    ['an empty object', {}],
    ['not an object', [1, 2]],
  ])(
    'when the grace is %s, then the read fails as malformed — never a guessed grace (guards an odd answer stretching the time PHI is only covered)',
    async (_case, body) => {
      answers(body);

      expect(await failureOf(readRuntimeConfig())).toMatchObject({
        kind: 'malformed-response',
        apiId: 'API-48',
      });
    },
  );

  it('when the body is not JSON (an HTML page from a proxy), then it fails as malformed', async () => {
    server.use(
      http.get(
        CONFIG_URL,
        () =>
          new HttpResponse('<!doctype html><title>x</title>', {
            headers: {'Content-Type': 'text/html'},
          }),
      ),
    );

    expect(await failureOf(readRuntimeConfig())).toMatchObject({
      kind: 'malformed-response',
      apiId: 'API-48',
    });
  });

  it('when the token handler fails (503), then it is a server error for API-48', async () => {
    server.use(
      http.get(CONFIG_URL, () => new HttpResponse(null, {status: 503})),
    );

    expect(await failureOf(readRuntimeConfig())).toMatchObject({
      kind: 'server-error',
      apiId: 'API-48',
    });
  });

  it('when the network fails, then it is a network error for API-48', async () => {
    server.use(http.get(CONFIG_URL, () => HttpResponse.error()));

    expect(await failureOf(readRuntimeConfig())).toMatchObject({
      kind: 'network-error',
      apiId: 'API-48',
    });
  });
});

describe('given the rule table shared with the token handler (config/runtime-config-rules.json)', () => {
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
    'when the served app list is %s, then the SPA keeps exactly what the token handler would serve (guards a rule widened on one side only)',
    async (_name, rule) => {
      answers({patientApps: rule.value, privacyGraceSeconds: 60});

      expect((await readRuntimeConfig()).patientApps).toEqual(
        rule.accepted ? (rule.expected ?? rule.value) : [],
      );
    },
  );

  it.each(SHARED_RULES.privacyGraceSeconds.map(c => [c.case, c] as const))(
    'when the served grace is %s, then the SPA accepts exactly what the token handler would serve (guards a cap raised on one side only locking everyone out)',
    async (_name, rule) => {
      answers({patientApps: [], privacyGraceSeconds: rule.value});

      if (rule.accepted) {
        expect((await readRuntimeConfig()).privacyGraceSeconds).toBe(
          rule.value,
        );
      } else {
        expect(await failureOf(readRuntimeConfig())).toMatchObject({
          kind: 'malformed-response',
          apiId: 'API-48',
        });
      }
    },
  );
});
