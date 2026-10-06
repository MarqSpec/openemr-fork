import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {afterAll, describe, expect, it, vi} from 'vitest';

import clientsJson from '../../config/oauth-clients.json' with {type: 'json'};
import scopesJson from '../../config/oauth-scopes.json' with {type: 'json'};
import {
  buildRegistrationRequest,
  checkScopePolicy,
  devicePathProblem,
  flattenScopesSupported,
  isInsideRepo,
  missingScopes,
  run,
  type ClientsConfig,
  type PathProbe,
  type RunDeps,
} from './registration.ts';

// reference: REQUIREMENTS.md FR-AUTH-6, NFR-SEC-4;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(FRONTEND, '..');
const SCOPES: readonly string[] = scopesJson.scopes;
const BASE = 'https://openemr.example.test';
const ORIGIN = 'https://frontend.example.test';
const SECRET = 'synthetic-secret-0123456789';
const SECRET_PATH = path.resolve(REPO_ROOT, '..', 'outside-repo', 'secret.txt');

function clients(
  overrides: Partial<ClientsConfig['environments'][string]> = {},
): ClientsConfig {
  return {
    clientName: 'openemr-frontend (token handler)',
    environments: {
      staging: {
        openemrBaseUrl: BASE,
        site: 'default',
        frontendOrigin: ORIGIN,
        clientId: null,
        ...overrides,
      },
    },
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

interface Server {
  openid?: Response;
  smart?: Response;
  registration?: (body: Record<string, unknown>) => Response;
}

function openidConfig(
  scopes: unknown = SCOPES,
  issuer = `${BASE}/oauth2/default`,
) {
  return {
    issuer,
    registration_endpoint: `${issuer}/registration`,
    scopes_supported: scopes,
  };
}

function smartConfig(
  scopes: unknown = [SCOPES],
  issuer = `${BASE}/apis/default/fhir`,
) {
  return {issuer, scopes_supported: scopes};
}

function registered(body: Record<string, unknown>): Response {
  return json({
    client_id: 'synthetic-client-id',
    client_secret: SECRET,
    registration_access_token: 'synthetic-registration-token',
    ...body,
  });
}

function harness(server: Server = {}, scopes: readonly string[] = SCOPES) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const written: {path: string; secret: string}[] = [];
  const events: string[] = [];
  const fetchStub = vi.fn(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({url, init});
      if (url === `${BASE}/oauth2/default/.well-known/openid-configuration`) {
        return Promise.resolve(server.openid ?? json(openidConfig()));
      }
      if (url === `${BASE}/apis/default/fhir/.well-known/smart-configuration`) {
        return Promise.resolve(server.smart ?? json(smartConfig()));
      }
      if (url === `${BASE}/oauth2/default/registration`) {
        events.push(`POST ${url}`);
        const body = JSON.parse(bodyText(init)) as Record<string, unknown>;
        return Promise.resolve((server.registration ?? registered)(body));
      }
      return Promise.resolve(new Response('not found', {status: 404}));
    },
  );
  const deps: RunDeps = {
    fetch: fetchStub,
    secretFile: {
      reserve: target => {
        events.push(`reserve ${target}`);
        return Promise.resolve();
      },
      write: (target, secret) => {
        written.push({path: target, secret});
        events.push(`write ${target}`);
        return Promise.resolve();
      },
      discard: target => {
        events.push(`discard ${target}`);
        return Promise.resolve();
      },
    },
    out: line => out.push(line),
    err: line => err.push(line),
    clients: clients(),
    approvedScopes: scopes,
    repoRoot: REPO_ROOT,
    cwd: REPO_ROOT,
  };
  const posts = () => calls.filter(c => c.init?.method === 'POST');
  return {deps, calls, posts, out, err, written, events};
}

const REGISTER = ['--env', 'staging', '--secret-out', SECRET_PATH];

describe('the scope list in config/oauth-scopes.json', () => {
  it('passes the read-only least-privilege policy (NFR-SEC-4)', () => {
    expect(checkScopePolicy(SCOPES, SCOPES)).toEqual([]);
  });

  it('holds no write, system/ or wildcard scope', () => {
    for (const scope of SCOPES) {
      expect(scope).not.toMatch(/^system\/|\*|\.write$|\.[cruds]+$/);
    }
  });
});

describe('config/oauth-clients.json', () => {
  it('records local, staging and production, and no secret', () => {
    expect(Object.keys(clientsJson.environments).sort()).toEqual([
      'local',
      'production',
      'staging',
    ]);
    expect(JSON.stringify(clientsJson)).not.toMatch(/secret"\s*:/i);
  });

  // review: the local dev stack is per workstation, so its id is not recorded.
  it('marks only local as not recording its client id', () => {
    const recorded = Object.entries(clientsJson.environments).map(
      ([env, config]) => [
        env,
        !('recordClientId' in config) || config.recordClientId,
      ],
    );
    expect(Object.fromEntries(recorded)).toEqual({
      local: false,
      staging: true,
      production: true,
    });
  });
});

describe('isInsideRepo', () => {
  // A throwaway "repository" outside the real one, so links can point into it.
  const base = mkdtempSync(path.join(tmpdir(), 'oauth-client-'));
  const repo = path.join(base, 'repo');
  mkdirSync(path.join(repo, 'sub'), {recursive: true});
  mkdirSync(path.join(base, 'out'));
  afterAll(() => {
    rmSync(base, {recursive: true, force: true});
  });

  it.each([
    ['the root itself', repo],
    ['a file in it', path.join(repo, 's.txt')],
    ['a ..-prefixed name', path.join(repo, '..secret')],
    ['a ..-prefixed directory', path.join(repo, '..hidden', 's.txt')],
    ['a not-yet-existing subdirectory', path.join(repo, 'new', 'deep', 's')],
  ])('counts %s as inside', (_what, target) => {
    expect(isInsideRepo(target, repo)).toBe(true);
  });

  it.each([
    ['the parent', base],
    ['a sibling', path.join(base, 'out', 's.txt')],
    ['a sibling sharing the prefix', path.join(base, 'repo2', 's.txt')],
    ['a sibling named ..repo', path.join(base, '..repo', 's.txt')],
  ])('counts %s as outside', (_what, target) => {
    expect(isInsideRepo(target, repo)).toBe(false);
  });

  it('counts a path through a link into the repository as inside', ctx => {
    const link = path.join(base, 'link');
    try {
      // 'junction' on Windows needs no privilege; ignored elsewhere.
      symlinkSync(repo, link, 'junction');
    } catch {
      ctx.skip();
    }
    expect(isInsideRepo(path.join(link, 's.txt'), repo)).toBe(true);
    expect(isInsideRepo(path.join(link, 'sub', 'new', 's'), repo)).toBe(true);
  });

  // review of a separate change round 2: a link to a subfolder is not the root itself.
  it('counts a path through a link into a subfolder of the repository as inside', ctx => {
    const link = path.join(base, 'sublink');
    try {
      symlinkSync(path.join(repo, 'sub'), link, 'junction');
    } catch {
      ctx.skip();
    }
    expect(isInsideRepo(path.join(link, 's.txt'), repo)).toBe(true);
    expect(isInsideRepo(path.join(link, 'new', 'deep', 's'), repo)).toBe(true);
    expect(isInsideRepo(link, repo)).toBe(true);
  });

  // Win32 drops trailing dots and spaces from a path segment, so these open the repository itself.
  it.runIf(process.platform === 'win32').each([
    [`${repo}.`, 's.txt'],
    [`${repo} `, 's.txt'],
    [`${repo}...`, path.join('new', 'dir', 's.txt')],
    [path.join(repo, 'sub. '), 's.txt'],
  ])('counts %s\\%s as inside (trailing dots and spaces)', (dir, rest) => {
    expect(isInsideRepo(path.join(dir, rest), repo)).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'counts a UNC spelling of a path through a subfolder link as inside',
    ctx => {
      const link = path.join(base, 'unclink');
      const drive = /^([A-Za-z]):\\(.*)$/.exec(link);
      const unc = drive
        ? `\\\\localhost\\${drive[1] ?? ''}$\\${drive[2] ?? ''}`
        : '';
      try {
        symlinkSync(path.join(repo, 'sub'), link, 'junction');
      } catch {
        ctx.skip();
      }
      if (unc === '' || !existsSync(unc)) {
        ctx.skip(); // no administrative share on this machine
      }
      expect(isInsideRepo(path.join(unc, 's.txt'), repo)).toBe(true);
    },
  );

  it('counts a link to a sibling of the repository as outside', ctx => {
    const link = path.join(base, 'outlink');
    try {
      symlinkSync(path.join(base, 'out'), link, 'junction');
    } catch {
      ctx.skip();
    }
    expect(isInsideRepo(path.join(link, 's.txt'), repo)).toBe(false);
  });

  describe('with the file-system probes stubbed out', () => {
    const blind: PathProbe = {
      realPath: () => undefined,
      sameEntry: () => false,
    };

    // Only the segment logic can answer these: a '..'-prefix test would get them wrong.
    it.each([
      [path.join(repo, '..secret'), true],
      [path.join(repo, '..hidden', 's.txt'), true],
      [path.join(repo, '...', 's.txt'), true],
      [path.join(base, '..repo', 's.txt'), false],
      [path.join(repo, '..', 's.txt'), false],
    ])('judges %s by whole .. segments: inside=%s', (target, inside) => {
      expect(isInsideRepo(target, repo, blind)).toBe(inside);
    });

    it('trusts the real path when it lands inside the repository', () => {
      const probe: PathProbe = {
        realPath: p =>
          p.startsWith(path.join(base, 'elsewhere'))
            ? path.join(
                repo,
                'sub',
                path.relative(path.join(base, 'elsewhere'), p),
              )
            : p,
        sameEntry: () => false,
      };
      expect(
        isInsideRepo(path.join(base, 'elsewhere', 's.txt'), repo, probe),
      ).toBe(true);
      expect(isInsideRepo(path.join(base, 'out', 's.txt'), repo, probe)).toBe(
        false,
      );
    });
  });

  // a separate change. run() refuses these first, so only a direct call reaches isInsideRepo's own guard.
  describe('given a device-namespace path it cannot judge', () => {
    const GUID = '{0a1b2c3d-0000-4000-8000-000000000000}';
    const tripwire: PathProbe = {
      realPath: p => {
        throw new Error(`asked the file system for the real path of ${p}`);
      },
      sameEntry: a => {
        throw new Error(`asked the file system about ${a}`);
      },
    };

    it.each([
      String.raw`\\?\Volume` + GUID + String.raw`\x`,
      String.raw`\\.\Volume` + GUID + String.raw`\x\s.txt`,
      `//?/Volume${GUID}/x`,
      String.raw`\\?\GLOBALROOT\Device\HarddiskVolume3\x\s.txt`,
    ])('fails closed on %s, before asking the file system', target => {
      expect(isInsideRepo(target, repo)).toBe(true);
      expect(isInsideRepo(target, repo, tripwire)).toBe(true);
    });
  });

  it.runIf(process.platform === 'win32')(
    'counts a \\\\?\\ spelling of an inside path as inside',
    () => {
      expect(isInsideRepo(`\\\\?\\${path.join(repo, 's.txt')}`, repo)).toBe(
        true,
      );
    },
  );

  it.runIf(process.platform === 'win32')(
    'counts a differently-cased spelling as inside',
    () => {
      expect(isInsideRepo(path.join(repo, 's.txt').toUpperCase(), repo)).toBe(
        true,
      );
    },
  );
});

describe('checkScopePolicy', () => {
  it.each([
    ['user/Patient.write', 'write'],
    ['user/Patient.rs', 'read-only'],
    ['system/Patient.read', 'system/'],
    ['user/*.read', 'wildcard'],
    ['patient/Patient.read', 'section 2'],
    ['api:oemr', 'section 2'],
    // review: the rules ignore case, and any non-.read permission is refused
    ['System/Patient.read', 'system/'],
    ['SYSTEM/*.READ', 'wildcard'],
    ['USER/Patient.write', 'write'],
    ['user/Patient.WRITE', 'write'],
    ['user/Patient-x.write', 'write'],
    ['Patient/Observation.cruds', 'read-only'],
    ['User/Patient.read', 'section 2'],
    ['user/patient.read', 'section 2'],
    ['API:OEMR', 'section 2'],
    ['OpenID', 'section 2'],
  ])('refuses %s (%s)', (scope, reason) => {
    const problems = checkScopePolicy([...SCOPES, scope], SCOPES);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(scope);
    expect(problems[0]?.startsWith(`${scope}: `)).toBe(true);
    expect(problems[0]?.slice(scope.length + 2)).toContain(reason);
  });

  it('accepts offline_access: the refresh token behind the 10 h session (PRD Q-2, BUG-19)', () => {
    expect(SCOPES).toContain('offline_access');
    expect(checkScopePolicy(SCOPES, SCOPES)).toEqual([]);
    expect(checkScopePolicy(['openid', 'offline_access'], SCOPES)).toEqual([]);
  });

  it.each([
    'profile',
    'email',
    'launch',
    'online_access',
    'api:port',
    'site:default',
  ])(
    'refuses %s even when the approved list names it: offline_access is the only addition to openid, fhirUser and api:fhir',
    scope => {
      const problems = checkScopePolicy([...SCOPES, scope], [...SCOPES, scope]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(new RegExp(`^${scope}: `));
      expect(problems[0]).toContain('offline_access');
    },
  );

  it.each([
    ['user/Patient.write', 'write'],
    ['system/Patient.read', 'system/'],
    ['user/*.read', 'wildcard'],
  ])(
    'still refuses %s when the approved list names it (%s) — allowing offline_access loosened nothing else',
    (scope, reason) => {
      const problems = checkScopePolicy([...SCOPES, scope], [...SCOPES, scope]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(reason);
    },
  );

  it('refuses a duplicate scope', () => {
    expect(checkScopePolicy([...SCOPES, 'openid'], SCOPES)[0]).toContain(
      'duplicate',
    );
  });

  it('refuses an empty list', () => {
    expect(checkScopePolicy([], SCOPES)).not.toEqual([]);
  });
});

describe('flattenScopesSupported', () => {
  it('reads a flat list (openid-configuration)', () => {
    expect(flattenScopesSupported(['openid', 'api:fhir'])).toEqual([
      'openid',
      'api:fhir',
    ]);
  });

  it('reads the list nested one array deep (smart-configuration, BUG-42)', () => {
    expect(flattenScopesSupported([['openid', 'api:fhir']])).toEqual([
      'openid',
      'api:fhir',
    ]);
  });

  it('reads the values of an object (a PHP array with gaps in its keys)', () => {
    expect(flattenScopesSupported({'0': 'openid', '3': 'api:fhir'})).toEqual([
      'openid',
      'api:fhir',
    ]);
  });

  it('returns undefined when absent or empty', () => {
    expect(flattenScopesSupported(undefined)).toBeUndefined();
    expect(flattenScopesSupported([])).toBeUndefined();
  });
});

describe('missingScopes', () => {
  it('names every requested scope the server does not support', () => {
    expect(missingScopes(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });
});

describe('buildRegistrationRequest', () => {
  it('builds the RFC 7591 body for a confidential client', () => {
    expect(
      buildRegistrationRequest({
        clientName: 'openemr-frontend (token handler)',
        envName: 'staging',
        frontendOrigin: ORIGIN,
        scopes: ['openid', 'api:fhir'],
        contacts: [],
      }),
    ).toEqual({
      application_type: 'private',
      client_name: 'openemr-frontend (token handler) - staging',
      redirect_uris: [`${ORIGIN}/bff/callback`],
      post_logout_redirect_uris: [`${ORIGIN}/signed-out`],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'openid api:fhir',
    });
  });

  it('never sends jwks (BUG-26) and adds contacts only when given', () => {
    const body = buildRegistrationRequest({
      clientName: 'x',
      envName: 'local',
      frontendOrigin: 'http://localhost:5173',
      scopes: ['openid'],
      contacts: ['ops@example.invalid'],
    });
    expect(body).not.toHaveProperty('jwks');
    expect(body.contacts).toEqual(['ops@example.invalid']);
  });

  it.each([
    ['https://frontend.example.test/app', 'origin'],
    ['https://frontend.example.test/', 'origin'],
    ['http://frontend.example.test', 'https'],
    ['not a url', 'origin'],
  ])('refuses the frontend origin %s', (origin, reason) => {
    expect(() =>
      buildRegistrationRequest({
        clientName: 'x',
        envName: 'staging',
        frontendOrigin: origin,
        scopes: ['openid'],
        contacts: [],
      }),
    ).toThrow(reason);
  });
});

describe('run', () => {
  it('tells the operator to commit the client id where the environment records it', async () => {
    const h = harness();
    expect(await run(REGISTER, h.deps)).toBe(0);
    expect(h.err.join('\n')).toContain(
      'in config/oauth-clients.json and commit it',
    );
  });

  it('tells the operator not to commit the id where the environment does not record it', async () => {
    const h = harness();
    h.deps.clients = clients({recordClientId: false});
    expect(await run(REGISTER, h.deps)).toBe(0);
    const log = h.err.join('\n');
    expect(log).not.toContain('commit it');
    expect(log).toContain('not recorded in config/oauth-clients.json');
  });

  it('registers the client, prints its id and writes the secret only where told', async () => {
    const h = harness();
    expect(await run(REGISTER, h.deps)).toBe(0);

    const [post, ...others] = h.posts();
    expect(others).toEqual([]);
    expect(post?.url).toBe(`${BASE}/oauth2/default/registration`);
    expect(new Headers(post?.init?.headers).get('Content-Type')).toBe(
      'application/json',
    );
    expect(JSON.parse(bodyText(post?.init))).toMatchObject({
      application_type: 'private',
      token_endpoint_auth_method: 'client_secret_post',
      redirect_uris: [`${ORIGIN}/bff/callback`],
      post_logout_redirect_uris: [`${ORIGIN}/signed-out`],
      scope: SCOPES.join(' '),
    });
    expect(h.written).toEqual([{path: SECRET_PATH, secret: SECRET}]);
    expect(h.out).toContain('client_id=synthetic-client-id');
    const printed = [...h.out, ...h.err].join('\n');
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain('synthetic-registration-token');
    expect(printed).toContain('Enable');
  });

  it('prints the secret to stdout only when --secret-out is -', async () => {
    const h = harness();
    expect(await run(['--env', 'staging', '--secret-out', '-'], h.deps)).toBe(
      0,
    );
    expect(h.written).toEqual([]);
    expect(h.out).toContain(`client_secret=${SECRET}`);
    expect(h.err.join('\n')).not.toContain(SECRET);
  });

  it('accepts the SMART list nested one array deep (BUG-42)', async () => {
    const h = harness({smart: json(smartConfig([SCOPES]))});
    expect(await run(REGISTER, h.deps)).toBe(0);
  });

  it('refuses to start without --secret-out', async () => {
    const h = harness();
    expect(await run(['--env', 'staging'], h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err.join('\n')).toContain('--secret-out');
  });

  it('refuses a secret path inside the git repository', async () => {
    const h = harness();
    const inside = path.join(REPO_ROOT, 'openemr-frontend', 'secret.txt');
    expect(
      await run(['--env', 'staging', '--secret-out', inside], h.deps),
    ).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err.join('\n')).toContain('repository');
  });

  // review: a name that merely starts with '..' is inside, not a parent step.
  it.each([
    '../..oauth-staging.secret',
    String.raw`..\..oauth-staging.secret`,
    '..oauth.secret',
    path.join(REPO_ROOT, '..hidden', 's.txt'),
    path.join(REPO_ROOT, 'openemr-frontend', '..', '..x', 's.txt'),
  ])(
    'refuses %s, a ..-prefixed name inside the repository',
    async secretOut => {
      const h = harness();
      h.deps.cwd = FRONTEND;
      expect(
        await run(['--env', 'staging', '--secret-out', secretOut], h.deps),
      ).toBe(2);
      expect(h.calls).toEqual([]);
      expect(h.err.join('\n')).toContain('inside the git repository');
    },
  );

  it('refuses a path through a link, outside the repository, to one of its subfolders', async ctx => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oauth-client-run-'));
    const link = path.join(dir, 'frontend');
    let linked = false;
    try {
      symlinkSync(FRONTEND, link, 'junction');
      linked = true;
      const h = harness();
      const secretOut = path.join(link, 'oauth-staging.secret');
      expect(
        await run(['--env', 'staging', '--secret-out', secretOut], h.deps),
      ).toBe(2);
      expect(h.calls).toEqual([]);
      expect(h.err.join('\n')).toContain('inside the git repository');
    } catch (e) {
      if (!linked) {
        ctx.skip();
      }
      throw e;
    } finally {
      // Never recursive: the link points into this checkout.
      if (linked) {
        try {
          unlinkSync(link);
        } catch {
          rmdirSync(link);
        }
      }
      rmdirSync(dir);
    }
  });

  // review of a separate change round 3: only drive and UNC namespaced forms are understood; the rest are refused.
  const GUID = '{0a1b2c3d-0000-4000-8000-000000000000}';
  const DEVICE_PATHS = [
    String.raw`\\?\Volume` + GUID + String.raw`\tmp\s.txt`,
    String.raw`\\.\Volume` + GUID + String.raw`\s.txt`,
    String.raw`\\?\GLOBALROOT\Device\HarddiskVolume3\tmp\s.txt`,
    `//?/Volume${GUID}/s.txt`,
    String.raw`\\.\pipe\oauth`,
    String.raw`\\.\NUL`,
    String.raw`\\?\UNC\server-only`,
    String.raw`\\.\UNC\server\share\s.txt`,
  ];
  // Round 3 ran outside the repo; both cwds are set so no re-rooted path is refused by accident.
  const outsideCwd = mkdtempSync(path.join(tmpdir(), 'oauth-client-cwd-'));
  afterAll(() => {
    rmSync(outsideCwd, {recursive: true, force: true});
  });
  it('runs the outside-cwd cases from a folder that really is outside the repository', () => {
    expect(isInsideRepo(outsideCwd, REPO_ROOT)).toBe(false);
  });
  describe.each([
    ['inside the repository', FRONTEND],
    ['outside the repository', outsideCwd],
  ])('from a working directory %s', (_where, cwd) => {
    it.each(DEVICE_PATHS)(
      'refuses the device-namespace path %s',
      async secretOut => {
        const h = harness();
        h.deps.cwd = cwd;
        const previous = process.cwd();
        process.chdir(cwd);
        try {
          expect(
            await run(['--env', 'staging', '--secret-out', secretOut], h.deps),
          ).toBe(2);
        } finally {
          process.chdir(previous);
        }
        expect(h.calls).toEqual([]);
        expect(h.events).toEqual([]);
        expect(h.err.join('\n')).toContain(
          'device-namespace paths are not supported for --secret-out',
        );
      },
    );
  });

  it.each([
    String.raw`\\?\C:\x\s.txt`,
    String.raw`\\.\c:\x\s.txt`,
    '//?/C:/x/s.txt',
    String.raw`\\?\UNC\server\share\s.txt`,
    String.raw`\\?\unc\server\share`,
  ])('understands the namespaced form %s', secretOut => {
    expect(devicePathProblem(secretOut)).toBeUndefined();
  });

  it.each(['C:\\x\\s.txt', '/tmp/s.txt', 's.txt', '\\\\server\\share\\s.txt'])(
    'leaves the ordinary path %s alone',
    secretOut => {
      expect(devicePathProblem(secretOut)).toBeUndefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'still registers to an accepted namespaced drive path outside the repository',
    async () => {
      const h = harness();
      const secretOut = `\\\\?\\${SECRET_PATH}`;
      expect(
        await run(['--env', 'staging', '--secret-out', secretOut], h.deps),
      ).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'still refuses an accepted namespaced drive path inside the repository',
    async () => {
      const h = harness();
      const secretOut = `\\\\?\\${path.join(REPO_ROOT, 's.txt')}`;
      expect(
        await run(['--env', 'staging', '--secret-out', secretOut], h.deps),
      ).toBe(2);
      expect(h.err.join('\n')).toContain('inside the git repository');
    },
  );

  it('accepts a real parent step out of the repository', async () => {
    const h = harness();
    h.deps.cwd = FRONTEND;
    const outside = '../../outside-repo-oauth.secret';
    expect(
      await run(['--env', 'staging', '--secret-out', outside], h.deps),
    ).toBe(0);
    expect(h.written[0]?.path).toBe(path.resolve(FRONTEND, outside));
  });

  it('refuses an unknown environment', async () => {
    const h = harness();
    expect(
      await run(['--env', 'qa', '--secret-out', SECRET_PATH], h.deps),
    ).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('refuses when the environment has no OpenEMR URL or frontend origin yet', async () => {
    const h = harness();
    h.deps.clients = clients({openemrBaseUrl: null});
    expect(await run(REGISTER, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err.join('\n')).toContain('--openemr-base-url');
  });

  it('takes the URLs from flags when config has none', async () => {
    const h = harness();
    h.deps.clients = clients({openemrBaseUrl: null, frontendOrigin: null});
    const argv = [
      ...REGISTER,
      '--openemr-base-url',
      BASE,
      '--frontend-origin',
      ORIGIN,
    ];
    expect(await run(argv, h.deps)).toBe(0);
  });

  it('registers a subset of the approved list given with --scopes', async () => {
    const h = harness();
    const subset = 'openid api:fhir user/Patient.read';
    expect(await run([...REGISTER, '--scopes', subset], h.deps)).toBe(0);
    expect(JSON.parse(bodyText(h.posts()[0]?.init))).toMatchObject({
      scope: subset,
    });
  });

  it.each([
    'openid user/Patient.write',
    'openid USER/Patient.read',
    'openid api:oemr',
    'openid patient/Patient.read',
  ])(
    'refuses --scopes "%s" against the approved list before any network call',
    async scopes => {
      const h = harness();
      expect(await run([...REGISTER, '--scopes', scopes], h.deps)).toBe(1);
      expect(h.calls).toEqual([]);
      expect(h.err.join('\n')).toContain(scopes.split(' ')[1]);
    },
  );

  it('refuses a scope list that breaks the policy before any network call', async () => {
    const h = harness({}, [...SCOPES, 'user/Patient.write']);
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err.join('\n')).toContain('user/Patient.write');
  });

  it('refuses when a scope is missing from scopes_supported (BUG-11)', async () => {
    const partial = SCOPES.filter(s => s !== 'user/Appointment.read');
    const h = harness({
      openid: json(openidConfig(partial)),
      smart: json(smartConfig([partial])),
    });
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.posts()).toEqual([]);
    expect(h.err.join('\n')).toContain('user/Appointment.read');
  });

  it('refuses when a scope is missing from either discovery document', async () => {
    const partial = SCOPES.filter(s => s !== 'fhirUser');
    const h = harness({smart: json(smartConfig([partial]))});
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.posts()).toEqual([]);
  });

  it('refuses when neither document advertises scopes_supported', async () => {
    const h = harness({
      openid: json({issuer: `${BASE}/oauth2/default`}),
      smart: json({issuer: `${BASE}/apis/default/fhir`}),
    });
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.posts()).toEqual([]);
  });

  it('refuses when the issuer is not built from this base URL (site_addr_oath, BUG-17)', async () => {
    const h = harness({
      openid: json(
        openidConfig(SCOPES, 'https://other.example.test/oauth2/default'),
      ),
    });
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.posts()).toEqual([]);
    expect(h.err.join('\n')).toContain('site_addr_oath');
  });

  it('refuses when the SMART issuer (the aud) is not the FHIR base (BUG-17)', async () => {
    const h = harness({
      smart: json(smartConfig([SCOPES], `${BASE}/apis/default/fhir/`)),
    });
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.posts()).toEqual([]);
    expect(h.err.join('\n')).toContain('site_addr_oath');
  });

  // review: the dev stack's https://localhost:9300 is self-signed.
  it('points at NODE_EXTRA_CA_CERTS when the certificate is untrusted', async () => {
    const h = harness();
    const cause = Object.assign(new Error('self-signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    h.deps.fetch = () => Promise.reject(new TypeError('fetch failed', {cause}));
    expect(await run(REGISTER, h.deps)).toBe(1);
    const log = h.err.join('\n');
    expect(log).toContain('NODE_EXTRA_CA_CERTS');
    expect(log).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(log).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it('points at rest_fhir_api when discovery 404s (BUG-22)', async () => {
    const h = harness({openid: new Response('API is disabled', {status: 404})});
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.posts()).toEqual([]);
    expect(h.err.join('\n')).toContain('rest_fhir_api');
  });

  it('refuses to register a second client for an environment that has one (BUG-27)', async () => {
    const h = harness();
    h.deps.clients = clients({clientId: 'existing-client'});
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err.join('\n')).toContain('--allow-new-client');
  });

  it('registers a replacement when told to', async () => {
    const h = harness();
    h.deps.clients = clients({clientId: 'existing-client'});
    expect(await run([...REGISTER, '--allow-new-client'], h.deps)).toBe(0);
  });

  it('--dry-run checks discovery and prints the request without posting', async () => {
    const h = harness();
    expect(await run(['--env', 'staging', '--dry-run'], h.deps)).toBe(0);
    expect(h.posts()).toEqual([]);
    expect(h.calls).toHaveLength(2);
    expect(h.out.join('\n')).toContain('"application_type": "private"');
  });

  it('fails when the registration response lists fewer scopes than requested', async () => {
    const h = harness({
      registration: body =>
        registered({
          ...body,
          scope: SCOPES.filter(s => s !== 'user/Observation.read').join(' '),
        }),
    });
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.written).toEqual([{path: SECRET_PATH, secret: SECRET}]);
    expect(h.err.join('\n')).toContain(
      'registration response for client synthetic-client-id lacks user/Observation.read',
    );
  });

  it('fails when the server returns no client secret (not confidential)', async () => {
    const h = harness({
      registration: body => registered({...body, client_secret: ''}),
    });
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.written).toEqual([]);
  });

  it('reports a registration error without echoing the request', async () => {
    const h = harness({
      registration: () =>
        json({error: 'invalid_scope', error_description: 'bad scope'}, 400),
    });
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.err.join('\n')).toContain('invalid_scope');
  });
  it('refuses before registering when the secret file cannot be reserved', async () => {
    const h = harness();
    h.deps.secretFile.reserve = () =>
      Promise.reject(new Error('EEXIST: file already exists'));
    expect(await run(REGISTER, h.deps)).toBe(2);
    expect(h.posts()).toEqual([]);
    expect(h.err.join('\n')).toContain('nothing was registered');
  });

  it('reserves the secret file before the POST, and discards it when registration fails', async () => {
    const h = harness({
      registration: () => json({error: 'invalid_client_metadata'}, 400),
    });
    expect(await run(REGISTER, h.deps)).toBe(1);
    expect(h.events).toEqual([
      `reserve ${SECRET_PATH}`,
      `POST ${BASE}/oauth2/default/registration`,
      `discard ${SECRET_PATH}`,
    ]);
  });

  it('reserves, then registers, then writes and keeps the secret file', async () => {
    const h = harness();
    expect(await run(REGISTER, h.deps)).toBe(0);
    expect(h.events).toEqual([
      `reserve ${SECRET_PATH}`,
      `POST ${BASE}/oauth2/default/registration`,
      `write ${SECRET_PATH}`,
    ]);
  });

  it('names the orphaned client when the secret cannot be written', async () => {
    const h = harness();
    h.deps.secretFile.write = () => Promise.reject(new Error('EACCES'));
    expect(await run(REGISTER, h.deps)).toBe(1);
    const log = h.err.join('\n');
    expect(log).toContain('synthetic-client-id');
    expect(log).toContain('Disable');
    expect(log).not.toContain(SECRET);
  });
});
