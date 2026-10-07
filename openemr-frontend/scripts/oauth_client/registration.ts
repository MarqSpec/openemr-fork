// Registers the token handler's confidential OAuth client with one environment's OpenEMR (API-9).
// Pure logic plus an injectable run(); the CLI wrapper is register.ts.
// reference: DEPLOYMENT.md; REQUIREMENTS.md FR-AUTH-6, NFR-SEC-4;

import {realpathSync, statSync} from 'node:fs';
import path from 'node:path';

export interface EnvironmentConfig {
  openemrBaseUrl: string | null;
  site: string;
  frontendOrigin: string | null;
  clientId: string | null;
  /** false: the id is per workstation and never committed (local). Default true. */
  recordClientId?: boolean;
  note?: string;
}

export interface ClientsConfig {
  clientName: string;
  environments: Record<string, EnvironmentConfig>;
}

export interface RunDeps {
  fetch: typeof fetch;
  secretFile: SecretFile;
  out: (line: string) => void;
  err: (line: string) => void;
  clients: ClientsConfig;
  /** config/oauth-scopes.json: the approved list (INTERFACES.md section 2). */
  approvedScopes: readonly string[];
  repoRoot: string;
  cwd: string;
}

/** Where the client secret goes when --secret-out names a file. */
export interface SecretFile {
  /** Create it empty and owner-only; reject if it exists. Runs before the POST, so a failure registers nothing. */
  reserve: (target: string) => Promise<void>;
  write: (target: string, secret: string) => Promise<void>;
  /** Best effort: remove a reserved file that never received a secret. */
  discard: (target: string) => Promise<void>;
}

export interface RegistrationRequest {
  application_type: 'private';
  client_name: string;
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  token_endpoint_auth_method: 'client_secret_post';
  scope: string;
  contacts?: string[];
}

/**
 * The only scopes without a SMART resource/permission form: identity, the FHIR gate, and the refresh token behind
 * the 10 h session (PRD Q-2, BUG-19). Anything else of that shape is refused even on the approved list.
 */
export const NON_RESOURCE_SCOPES: readonly string[] = [
  'openid',
  'fhirUser',
  'api:fhir',
  'offline_access',
];

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

/** Problems with a requested scope list; empty means it may be registered. */
export function checkScopePolicy(
  scopes: readonly string[],
  allowed: readonly string[],
): string[] {
  if (scopes.length === 0) {
    return ['the scope list is empty'];
  }
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const scope of scopes) {
    if (seen.has(scope)) {
      problems.push(`${scope}: duplicate`);
      continue;
    }
    seen.add(scope);
    const reason = scopeViolation(scope, allowedSet);
    if (reason !== undefined) {
      problems.push(`${scope}: ${reason}`);
    }
  }
  return problems;
}

function scopeViolation(
  scope: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  // The rules ignore case; only the exact spelling in the approved list passes the last check.
  const lower = scope.toLowerCase();
  if (lower.includes('*')) {
    return 'wildcard scopes are never requested (NFR-SEC-4)';
  }
  if (lower.startsWith('system/')) {
    return 'system/ scopes are never requested (NFR-SEC-4)';
  }
  const slash = lower.indexOf('/');
  if (slash >= 0) {
    const dot = lower.lastIndexOf('.');
    const permission = dot > slash ? lower.slice(dot + 1) : '';
    if (permission.includes('write')) {
      return 'write scopes are never requested (NFR-SEC-4)';
    }
    if (permission !== 'read') {
      return 'only SMART v1 read-only .read scopes are requested (BUG-11, NFR-SEC-4)';
    }
  }
  if (!allowed.has(scope)) {
    return 'not in INTERFACES.md section 2';
  }
  if (slash < 0 && !NON_RESOURCE_SCOPES.includes(scope)) {
    return `only ${NON_RESOURCE_SCOPES.join(', ')} are requested besides SMART v1 .read scopes (NFR-SEC-4)`;
  }
  return undefined;
}

/** scopes_supported as a flat list: flat, nested one array deep (BUG-42) or a JSON object. */
export function flattenScopesSupported(value: unknown): string[] | undefined {
  const scopes: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      scopes.push(item);
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === 'object') {
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return scopes.length > 0 ? scopes : undefined;
}

export function missingScopes(
  requested: readonly string[],
  supported: readonly string[],
): string[] {
  const available = new Set(supported);
  return requested.filter(scope => !available.has(scope));
}

/** The origin, exactly: scheme://host[:port], no path; https unless loopback. */
function parseOrigin(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} ${value} is not an origin (scheme://host[:port])`);
  }
  if (url.origin !== value) {
    throw new Error(
      `${what} ${value} is not an origin (scheme://host[:port], no path or trailing slash)`,
    );
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error(
      `${what} ${value} must use https (http only for localhost)`,
    );
  }
  return url.origin;
}

/** OpenEMR's base: an origin plus an optional webroot path, no trailing slash. */
function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OpenEMR base URL ${value} is not a URL`);
  }
  if (url.search !== '' || url.hash !== '' || value.endsWith('/')) {
    throw new Error(
      `OpenEMR base URL ${value} must be scheme://host[:port][/webroot] with no trailing slash`,
    );
  }
  parseOrigin(url.origin, 'OpenEMR base URL');
  return value;
}

export function buildRegistrationRequest(input: {
  clientName: string;
  envName: string;
  frontendOrigin: string;
  scopes: readonly string[];
  contacts: readonly string[];
}): RegistrationRequest {
  const origin = parseOrigin(input.frontendOrigin, 'frontend origin');
  const body: RegistrationRequest = {
    application_type: 'private',
    client_name: `${input.clientName} - ${input.envName}`,
    redirect_uris: [`${origin}/bff/callback`],
    post_logout_redirect_uris: [`${origin}/signed-out`],
    token_endpoint_auth_method: 'client_secret_post',
    scope: input.scopes.join(' '),
  };
  if (input.contacts.length > 0) {
    body.contacts = [...input.contacts];
  }
  return body;
}

interface Args {
  env: string;
  secretOut?: string;
  openemrBaseUrl?: string;
  frontendOrigin?: string;
  site?: string;
  scopes?: string[];
  contacts: string[];
  dryRun: boolean;
  allowNewClient: boolean;
}

const USAGE = `usage: npm run oauth:register -- --env <local|staging|production>
    (--secret-out <path outside the repo> | --secret-out - | --dry-run)
    [--openemr-base-url <url>] [--frontend-origin <origin>] [--site <id>]
    [--scopes "<subset of config/oauth-scopes.json>"]
    [--contact <email>]... [--allow-new-client]
See DEPLOYMENT.md.`;

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = {
    env: '',
    contacts: [],
    dryRun: false,
    allowNewClient: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (flag === '--allow-new-client') {
      args.allowNewClient = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      return `${flag ?? ''} needs a value`;
    }
    i++;
    switch (flag) {
      case '--env':
        args.env = value;
        break;
      case '--secret-out':
        args.secretOut = value;
        break;
      case '--openemr-base-url':
        args.openemrBaseUrl = value;
        break;
      case '--frontend-origin':
        args.frontendOrigin = value;
        break;
      case '--site':
        args.site = value;
        break;
      case '--scopes':
        args.scopes = value.split(' ').filter(scope => scope !== '');
        break;
      case '--contact':
        args.contacts.push(value);
        break;
      default:
        return `unknown argument ${flag ?? ''}`;
    }
  }
  if (args.env === '') {
    return '--env is required';
  }
  if (!args.dryRun && args.secretOut === undefined) {
    return '--secret-out is required: a file path outside the repository, or - for stdout';
  }
  return args;
}

/** Win32 namespace spellings to plain ones: \\?\C:\x -> C:\x, \\?\UNC\h\s -> \\h\s. */
function stripWin32Namespace(p: string): string {
  if (NAMESPACED_UNC.test(p)) {
    return `\\\\${p.slice(8)}`;
  }
  return NAMESPACED_DRIVE.test(p) ? p.slice(4) : p;
}

// Win32 namespaced paths (either slash): only these three forms are understood.
const NAMESPACED = /^[\\/]{2}[?.][\\/]/;
const NAMESPACED_DRIVE = /^[\\/]{2}[?.][\\/][A-Za-z]:(?:[\\/]|$)/;
const NAMESPACED_UNC = /^[\\/]{2}\?[\\/]UNC[\\/][^\\/]+[\\/][^\\/]+/i;

/**
 * Why a path cannot be judged safely, or undefined. Volume{GUID}, GLOBALROOT, pipes and other device paths
 * would resolve relative to the working directory here while Windows opens them elsewhere, so they are refused.
 */
export function devicePathProblem(p: string): string | undefined {
  if (
    !NAMESPACED.test(p) ||
    NAMESPACED_DRIVE.test(p) ||
    NAMESPACED_UNC.test(p)
  ) {
    return undefined;
  }
  return 'device-namespace paths are not supported for --secret-out; use a normal drive or UNC path';
}

function isLexicallyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') {
    return true;
  }
  if (path.isAbsolute(relative)) {
    return false; // another drive or UNC root
  }
  // Only a whole '..' segment steps out: '..secret' is a name inside. On POSIX '\' is a name character.
  const separators = path.sep === '\\' ? /[\\/]/ : /\//;
  return relative.split(separators)[0] !== '..';
}

/** The file-system questions isInsideRepo asks; injectable so each rule can be tested alone. */
export interface PathProbe {
  /** p with every link resolved, for a p that need not exist yet; undefined if nothing resolves. */
  realPath: (p: string) => string | undefined;
  /** Whether a and b are the same existing entry (same device and inode, links followed). */
  sameEntry: (a: string, b: string) => boolean;
}

export const FS_PROBE: PathProbe = {
  realPath: p => {
    // realpath the nearest existing ancestor, then re-append what does not exist yet.
    const missing: string[] = [];
    for (let existing = p; ; existing = path.dirname(existing)) {
      try {
        const real = stripWin32Namespace(realpathSync.native(existing));
        return path.join(real, ...missing);
      } catch {
        if (path.dirname(existing) === existing) {
          return undefined;
        }
        missing.unshift(path.basename(existing));
      }
    }
  },
  sameEntry: (a, b) => {
    try {
      const x = statSync(a, {bigint: true});
      const y = statSync(b, {bigint: true});
      return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev;
    } catch {
      return false;
    }
  },
};

/**
 * Whether target is, or would be created, inside the repository. Any of: lexically (whole '..' segments,
 * case-insensitive on Windows); by real path, links resolved, so a link to any folder of the repository
 * counts; or an existing ancestor that is the repository root itself (catches UNC aliases of the root that
 * realpath does not map back to a drive letter).
 */
export function isInsideRepo(
  target: string,
  repoRoot: string,
  probe: PathProbe = FS_PROBE,
): boolean {
  if (devicePathProblem(target) !== undefined) {
    return true; // cannot be judged: fail closed
  }
  const child = win32Segments(path.resolve(stripWin32Namespace(target)));
  const parent = win32Segments(path.resolve(stripWin32Namespace(repoRoot)));
  if (isLexicallyInside(child, parent)) {
    return true;
  }
  const realChild = probe.realPath(child);
  const realParent = probe.realPath(parent) ?? parent;
  if (realChild !== undefined && isLexicallyInside(realChild, realParent)) {
    return true;
  }
  // The real path may be a UNC alias of the repository; compare identities along both spellings.
  const spellings = realChild === undefined ? [child] : [child, realChild];
  return spellings.some(spelling => {
    for (let dir = spelling; ; dir = path.dirname(dir)) {
      if (probe.sameEntry(dir, parent)) {
        return true;
      }
      if (path.dirname(dir) === dir) {
        return false;
      }
    }
  });
}

/**
 * On Windows, what Win32 will open: trailing dots and spaces dropped from each segment ('repo.' is 'repo').
 * A \\?\ path keeps them literally, so this can over-refuse such a path, never under-refuse.
 */
function win32Segments(p: string): string {
  if (path.sep !== '\\') {
    return p;
  }
  const {root} = path.parse(p);
  const segments = p
    .slice(root.length)
    .split('\\')
    .map(segment =>
      /^\.+$/.test(segment) ? segment : segment.replace(/[. ]+$/, ''),
    );
  return path.join(root, ...segments);
}

interface Target {
  env: string;
  base: string;
  site: string;
  origin: string;
  existingClientId: string | null;
  recordClientId: boolean;
}

function resolveTarget(args: Args, deps: RunDeps): Target | string {
  const config = deps.clients.environments[args.env];
  if (config === undefined) {
    const known = Object.keys(deps.clients.environments).join(', ');
    return `unknown environment ${args.env} (config/oauth-clients.json has: ${known})`;
  }
  const base = args.openemrBaseUrl ?? config.openemrBaseUrl;
  const origin = args.frontendOrigin ?? config.frontendOrigin;
  if (base === null) {
    return `${args.env} has no openemrBaseUrl in config/oauth-clients.json: pass --openemr-base-url`;
  }
  if (origin === null) {
    return `${args.env} has no frontendOrigin in config/oauth-clients.json: pass --frontend-origin`;
  }
  try {
    return {
      env: args.env,
      base: parseBaseUrl(base),
      site: args.site ?? config.site,
      origin: parseOrigin(origin, 'frontend origin'),
      existingClientId: config.clientId,
      recordClientId: config.recordClientId ?? true,
    };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

class Refusal extends Error {}

const UNTRUSTED_CERTIFICATE = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** fetch's error plus its cause; an untrusted certificate gets the fix that keeps TLS verification on. */
function describeNetworkError(e: unknown): string {
  if (!(e instanceof Error)) {
    return String(e);
  }
  const cause: unknown = e.cause;
  const code =
    cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
  const detail =
    cause instanceof Error ? `${e.message} (${cause.message})` : e.message;
  if (code !== undefined && UNTRUSTED_CERTIFICATE.has(code)) {
    return (
      `${detail} [${code}]. The certificate is not trusted: set NODE_EXTRA_CA_CERTS to a PEM file holding it ` +
      '(DEPLOYMENT.md, "The local dev stack"). Never turn TLS verification off.'
    );
  }
  return code === undefined ? detail : `${detail} [${code}]`;
}

async function getJson(
  deps: RunDeps,
  url: string,
  what: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(url, {headers: {Accept: 'application/json'}});
  } catch (e) {
    throw new Refusal(
      `${what} ${url} is unreachable: ${describeNetworkError(e)}`,
    );
  }
  if (response.status === 404) {
    throw new Refusal(
      `${what} ${url} returned 404. If the body says "API is disabled", enable the rest_fhir_api global ` +
        '(Administration > Config > Connectors, BUG-22); otherwise check the base URL, webroot and --site.',
    );
  }
  if (!response.ok) {
    throw new Refusal(
      `${what} ${url} returned HTTP ${String(response.status)}`,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Refusal(`${what} ${url} did not return a JSON object`);
  }
  return body as Record<string, unknown>;
}

/** API-1 and API-2: issuers built from site_addr_oath, and every scope supported. */
async function checkDiscovery(
  deps: RunDeps,
  target: Target,
  scopes: readonly string[],
): Promise<void> {
  const oauthBase = `${target.base}/oauth2/${target.site}`;
  const fhirBase = `${target.base}/apis/${target.site}/fhir`;
  const openid = await getJson(
    deps,
    `${oauthBase}/.well-known/openid-configuration`,
    'OpenID discovery (API-1)',
  );
  const smart = await getJson(
    deps,
    `${fhirBase}/.well-known/smart-configuration`,
    'SMART configuration (API-2)',
  );

  const issuers: [string, unknown, string][] = [
    ['OpenID discovery issuer', openid.issuer, oauthBase],
    ['SMART configuration issuer (the aud)', smart.issuer, fhirBase],
  ];
  for (const [what, actual, expected] of issuers) {
    if (actual !== expected) {
      throw new Refusal(
        `${what} is ${JSON.stringify(actual)}, expected ${expected}. OpenEMR builds it from the ` +
          'site_addr_oath global (Administration > Config > Connectors > Site Address): set it to the exact ' +
          'public origin, no trailing slash, or tokens will fail the aud check (BUG-17).',
      );
    }
  }

  const lists: [string, string[] | undefined][] = [
    ['openid-configuration', flattenScopesSupported(openid.scopes_supported)],
    ['smart-configuration', flattenScopesSupported(smart.scopes_supported)],
  ];
  const advertised = lists.filter(
    (entry): entry is [string, string[]] => entry[1] !== undefined,
  );
  if (advertised.length === 0) {
    throw new Refusal(
      'neither discovery document advertises scopes_supported; cannot validate the scope list (BUG-11)',
    );
  }
  for (const [name, supported] of advertised) {
    const missing = missingScopes(scopes, supported);
    if (missing.length > 0) {
      throw new Refusal(
        `${name} scopes_supported lacks ${missing.join(' ')}. One unknown scope fails registration and ` +
          'every login (BUG-11); fix config/oauth-scopes.json together with INTERFACES.md section 2, ' +
          'or the server.',
      );
    }
  }
}

function describeError(body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const {error, error_description: description} = body as Record<
      string,
      unknown
    >;
    if (typeof error === 'string') {
      return typeof description === 'string'
        ? `${error}: ${description}`
        : error;
    }
  }
  return 'no OAuth error in the response body';
}

function nextSteps(
  clientId: string,
  secretPath: string | undefined,
  recordClientId: boolean,
): string[] {
  const record = recordClientId
    ? `  2. Record "clientId": "${clientId}" for this environment in config/oauth-clients.json and commit it (the id is public).`
    : `  2. This environment's client id is not recorded in config/oauth-clients.json (per workstation): keep "${clientId}" in your untracked environment.`;
  const secret =
    secretPath === undefined
      ? "  3. The client secret is printed on stdout above: put it in the token handler's server-side environment / a secret in your CI or hosting platform, never in git."
      : `  3. The client secret is written to ${secretPath}: put it in the token handler's server-side environment / a secret in your CI or hosting platform, never in git, then delete the file.`;
  return [
    'Next (operator steps, DEPLOYMENT.md):',
    `  1. Enable the client: Administration > System > API Clients > ${clientId} > Enable Client. It is created disabled (BUG-14).`,
    record,
    secret,
  ];
}

/** The whole registration; returns the process exit code. */
export async function run(
  argv: readonly string[],
  deps: RunDeps,
): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    deps.err(args);
    deps.err(USAGE);
    return EXIT_USAGE;
  }

  let secretPath: string | undefined;
  if (args.secretOut !== undefined && args.secretOut !== '-') {
    const problem = devicePathProblem(args.secretOut);
    if (problem !== undefined) {
      deps.err(`refusing --secret-out ${args.secretOut}: ${problem}.`);
      return EXIT_USAGE;
    }
    secretPath = path.resolve(deps.cwd, args.secretOut);
    if (isInsideRepo(secretPath, deps.repoRoot)) {
      deps.err(
        `refusing --secret-out ${secretPath}: it is inside the git repository ${deps.repoRoot}. ` +
          'The client secret never goes in the repo; choose a path outside it, or - for stdout.',
      );
      return EXIT_USAGE;
    }
  }

  const target = resolveTarget(args, deps);
  if (typeof target === 'string') {
    deps.err(target);
    return EXIT_USAGE;
  }

  // The approved list must itself pass the rules; the requested list must also be drawn from it.
  const approved = deps.approvedScopes;
  const scopes = args.scopes ?? approved;
  const policy: [string, string[]][] = [
    ['config/oauth-scopes.json', checkScopePolicy(approved, approved)],
    ['--scopes', args.scopes ? checkScopePolicy(scopes, approved) : []],
  ];
  for (const [source, problems] of policy) {
    if (problems.length > 0) {
      deps.err(
        `refusing: ${source} breaks the read-only, approved-list policy (NFR-SEC-4):`,
      );
      for (const problem of problems) {
        deps.err(`  ${problem}`);
      }
      return EXIT_REFUSED;
    }
  }

  if (target.existingClientId !== null && !args.allowNewClient) {
    deps.err(
      `refusing: ${target.env} already has client ${target.existingClientId} in config/oauth-clients.json. ` +
        'Registering again creates a second client, not an update (BUG-27). If that client is gone (e.g. after ' +
        'a reseed) or must be rotated, re-run with --allow-new-client and disable the old one.',
    );
    return EXIT_REFUSED;
  }

  const request = buildRegistrationRequest({
    clientName: deps.clients.clientName,
    envName: target.env,
    frontendOrigin: target.origin,
    scopes,
    contacts: args.contacts,
  });

  try {
    await checkDiscovery(deps, target, scopes);
  } catch (e) {
    if (e instanceof Refusal) {
      deps.err(`refusing: ${e.message}`);
      return EXIT_REFUSED;
    }
    throw e;
  }
  deps.err(
    `discovery OK: issuers match ${target.base}, all ${String(scopes.length)} scopes supported`,
  );

  const endpoint = `${target.base}/oauth2/${target.site}/registration`;
  if (args.dryRun) {
    deps.out(`POST ${endpoint}`);
    deps.out(JSON.stringify(request, null, 2));
    deps.err('dry run: nothing registered');
    return EXIT_OK;
  }

  if (secretPath !== undefined) {
    try {
      await deps.secretFile.reserve(secretPath);
    } catch (e) {
      deps.err(
        `refusing --secret-out ${secretPath}: ${e instanceof Error ? e.message : String(e)}. ` +
          'It must not exist yet and its directory must be writable; nothing was registered.',
      );
      return EXIT_USAGE;
    }
  }
  return register(deps, endpoint, request, scopes, secretPath, target);
}

async function register(
  deps: RunDeps,
  endpoint: string,
  request: RegistrationRequest,
  scopes: readonly string[],
  secretPath: string | undefined,
  target: Target,
): Promise<number> {
  let secretWritten = false;
  try {
    const result = await post(deps, endpoint, request);
    if (typeof result === 'number') {
      return result;
    }
    const {clientId, secret, registeredScope} = result;
    if (secretPath === undefined) {
      deps.out(`client_secret=${secret}`);
    } else {
      try {
        await deps.secretFile.write(secretPath, secret);
        secretWritten = true;
      } catch (e) {
        deps.err(
          `client ${clientId} was registered but its secret could not be written to ${secretPath} ` +
            `(${e instanceof Error ? e.message : String(e)}): the secret is lost. Disable ${clientId} in ` +
            'Administration > System > API Clients and register again.',
        );
        return EXIT_REFUSED;
      }
      deps.err(`client secret written to ${secretPath}`);
    }

    // OpenEMR echoes the requested scope, so this only catches a server that reports narrowing; BUG-20 shows at sign-in.
    const dropped = missingScopes(scopes, registeredScope);
    if (dropped.length > 0) {
      deps.err(
        `the registration response for client ${clientId} lacks ${dropped.join(' ')}, so the client may not ` +
          'hold every requested scope. Disable this client and investigate before using it.',
      );
      return EXIT_REFUSED;
    }
    for (const line of nextSteps(clientId, secretPath, target.recordClientId)) {
      deps.err(line);
    }
    return EXIT_OK;
  } finally {
    if (secretPath !== undefined && !secretWritten) {
      await deps.secretFile.discard(secretPath).catch(() => undefined);
    }
  }
}

interface Registered {
  clientId: string;
  secret: string;
  registeredScope: string[];
}

async function post(
  deps: RunDeps,
  endpoint: string,
  request: RegistrationRequest,
): Promise<Registered | number> {
  let response: Response;
  try {
    response = await deps.fetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify(request),
    });
  } catch (e) {
    deps.err(
      `registration ${endpoint} is unreachable: ${describeNetworkError(e)}`,
    );
    return EXIT_REFUSED;
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    deps.err(
      `registration failed: HTTP ${String(response.status)}, ${describeError(body)}`,
    );
    return EXIT_REFUSED;
  }
  const registered = (body ?? {}) as Record<string, unknown>;
  const clientId = registered.client_id;
  const secret = registered.client_secret;
  if (typeof clientId !== 'string' || clientId === '') {
    deps.err('registration returned no client_id');
    return EXIT_REFUSED;
  }
  deps.out(`client_id=${clientId}`);
  if (typeof secret !== 'string' || secret === '') {
    deps.err(
      `client ${clientId} came back with no client_secret, so it is not confidential and cannot hold user/ ` +
        'scopes (BUG-1). Disable it in Administration > System > API Clients.',
    );
    return EXIT_REFUSED;
  }
  const registeredScope =
    typeof registered.scope === 'string' ? registered.scope.split(' ') : [];
  return {clientId, secret, registeredScope};
}
