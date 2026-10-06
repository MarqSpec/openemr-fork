import {existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {inspect} from 'node:util';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * `host-prefixed`: `__Host-` cookies, `Secure` — every deployed environment. `dev-insecure`: plain names, no
 * `Secure`, for `http://localhost` development only (FR-BFF-1).
 */
export type CookieMode = 'host-prefixed' | 'dev-insecure';

/** A credential that never serialises: JSON, `util.inspect` and string conversion all print `[redacted]`. */
export class Secret {
  constructor(private readonly value: string) {}

  reveal(): string {
    return this.value;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return '[redacted]';
  }
}

/** The confidential OAuth client (FR-BFF-2); the secret comes from the server-side environment only. */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: Secret;
  /** Budget for each call to OpenEMR's discovery, JWKS and token endpoints, in ms. */
  timeoutMs: number;
}

/**
 * How long a session may last (FR-BFF-4): idle is measured from the last authenticated request, the maximum from
 * sign-in; either ends the session whatever the refresh token allows.
 */
export interface SessionLimits {
  /** FR-AUTH-4: default 15 minutes. */
  idleTimeoutMs: number;
  /** PRD Q-2: one clinic day, 10 hours, by default. */
  maxSessionMs: number;
}

/** The allow-listed FHIR read proxy, API-44 (FR-BFF-3, BUG-28). */
export interface FhirProxyConfig {
  /** `{OpenEMR}/apis/{site}/fhir`, from configuration only: the one place the bearer token is ever sent. */
  baseUrl: string;
  /** Budget for one proxied read, queue wait included, in ms; FHIR takes 4–8 s under load (BUG-28). */
  timeoutMs: number;
  /** Upstream calls in flight at once, across every session. */
  maxConcurrent: number;
  /** Of those, at most this many for one session, so one dashboard cannot starve the others. */
  maxConcurrentPerSession: number;
}

/** Everything the token handler reads from its environment, parsed once at start-up. */
export interface Config {
  port: number;
  host: string;
  /** Absolute path of the `vite build` output served at `/`. */
  spaDistDir: string;
  /** API-2: `{OpenEMR}/apis/{site}/fhir/.well-known/smart-configuration`. */
  smartDiscoveryUrl: string;
  /** API-1: `{OpenEMR}/oauth2/{site}/.well-known/openid-configuration` — the id_token issuer and end-session. */
  openidDiscoveryUrl: string;
  /** The origin the browser is sent to for sign-in; CSP `form-action` allows it. */
  authorizeOrigin: string;
  /** This service's own public origin: the redirect URIs are built on it and FR-BFF-6 compares `Origin` to it. */
  publicOrigin: string;
  cookieMode: CookieMode;
  oauth: OAuthClientConfig;
  readyTimeoutMs: number;
  fhirProxy: FhirProxyConfig;
  logLevel: LogLevel;
  session: SessionLimits;
  /** The commit the image was built from (`BUILD_SHA`), or `unknown`; public, reported by `/bff/health`. */
  build: string;
}

/** Raised at start-up; its message names each bad variable and the rule, never the value. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid configuration:\n${problems.map(problem => `  - ${problem}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const SITE_PATTERN = /^[A-Za-z0-9_-]+$/;
const BUILD_SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Printable ASCII with no whitespace: what OpenEMR issues, and nothing a copy-paste slip can pad.
const CREDENTIAL_PATTERN = /^[\x21-\x7e]+$/;

/** Parses the environment into a {@link Config}, or throws a {@link ConfigError} listing every problem. */
export function loadConfig(env: Environment): Config {
  const problems: string[] = [];
  const fail: Fail = (variable, rule) => {
    problems.push(`${variable}: ${rule}`);
  };

  const port = parseInteger(env, 'PORT', 8080, 1, 65_535, fail);
  const readyTimeoutMs = parseInteger(
    env,
    'BFF_READY_TIMEOUT_MS',
    5000,
    1,
    60_000,
    fail,
  );
  const oauthTimeoutMs = parseInteger(
    env,
    'BFF_OAUTH_TIMEOUT_MS',
    10_000,
    1,
    60_000,
    fail,
  );
  const idleTimeoutS = parseInteger(
    env,
    'BFF_IDLE_TIMEOUT_SECONDS',
    15 * 60,
    60,
    60 * 60,
    fail,
  );
  const maxSessionS = parseInteger(
    env,
    'BFF_MAX_SESSION_SECONDS',
    10 * 60 * 60,
    5 * 60,
    24 * 60 * 60,
    fail,
  );
  if (
    idleTimeoutS !== undefined &&
    maxSessionS !== undefined &&
    idleTimeoutS > maxSessionS
  ) {
    fail('BFF_IDLE_TIMEOUT_SECONDS', 'must not exceed BFF_MAX_SESSION_SECONDS');
  }
  const fhirProxy = parseFhirProxy(env, fail);
  const host = env.BFF_HOST ?? '0.0.0.0';

  const logLevelRaw = env.BFF_LOG_LEVEL ?? 'info';
  const logLevel = LOG_LEVELS.find(level => level === logLevelRaw);
  if (logLevel === undefined) {
    fail('BFF_LOG_LEVEL', `must be one of ${LOG_LEVELS.join(', ')}`);
  }

  const spaDistDir = parseDistDir(env.BFF_SPA_DIST_DIR, fail);

  // An image built without the build arg carries an empty BUILD_SHA: that is "unknown", not an error.
  const build =
    env.BUILD_SHA === undefined || env.BUILD_SHA === ''
      ? 'unknown'
      : env.BUILD_SHA;
  if (build !== 'unknown' && !BUILD_SHA_PATTERN.test(build)) {
    fail('BUILD_SHA', 'must be a lower-case hex commit id (7-40 characters)');
  }

  const site = env.OPENEMR_SITE ?? 'default';
  if (!SITE_PATTERN.test(site)) {
    fail(
      'OPENEMR_SITE',
      'must be an OpenEMR site id (letters, digits, _ or -)',
    );
  }

  const baseUrl = parseHttpUrl(env.OPENEMR_BASE_URL, 'OPENEMR_BASE_URL', fail);
  if (baseUrl !== undefined && (baseUrl.search !== '' || baseUrl.hash !== '')) {
    fail('OPENEMR_BASE_URL', 'must not carry a query string or fragment');
  }

  let authorizeOrigin = baseUrl?.origin;
  const authorizeRaw = env.OPENEMR_AUTHORIZE_ORIGIN;
  if (authorizeRaw !== undefined) {
    const parsed = parseHttpUrl(authorizeRaw, 'OPENEMR_AUTHORIZE_ORIGIN', fail);
    if (parsed !== undefined && `${parsed.origin}/` !== parsed.href) {
      fail(
        'OPENEMR_AUTHORIZE_ORIGIN',
        'must be a bare origin (scheme://host[:port]) with no path, query or fragment',
      );
    } else {
      authorizeOrigin = parsed?.origin;
    }
  }

  const publicOrigin = parseOrigin(env.BFF_PUBLIC_ORIGIN, fail);
  const cookieMode = parseCookieMode(env, publicOrigin, fail);
  const clientId = parseCredential(
    env.OAUTH_CLIENT_ID,
    'OAUTH_CLIENT_ID',
    fail,
  );
  const clientSecret = parseCredential(
    env.OAUTH_CLIENT_SECRET,
    'OAUTH_CLIENT_SECRET',
    fail,
  );

  if (
    problems.length > 0 ||
    port === undefined ||
    readyTimeoutMs === undefined ||
    oauthTimeoutMs === undefined ||
    idleTimeoutS === undefined ||
    maxSessionS === undefined ||
    fhirProxy === undefined ||
    publicOrigin === undefined ||
    cookieMode === undefined ||
    clientId === undefined ||
    clientSecret === undefined ||
    logLevel === undefined ||
    spaDistDir === undefined ||
    baseUrl === undefined ||
    authorizeOrigin === undefined
  ) {
    throw new ConfigError(problems);
  }

  const openemrBase = `${baseUrl.origin}${baseUrl.pathname.replace(/\/+$/, '')}`;
  return {
    port,
    host,
    spaDistDir,
    smartDiscoveryUrl: `${openemrBase}/apis/${site}/fhir/.well-known/smart-configuration`,
    openidDiscoveryUrl: `${openemrBase}/oauth2/${site}/.well-known/openid-configuration`,
    authorizeOrigin,
    publicOrigin: publicOrigin.origin,
    cookieMode,
    oauth: {
      clientId,
      clientSecret: new Secret(clientSecret),
      timeoutMs: oauthTimeoutMs,
    },
    readyTimeoutMs,
    fhirProxy: {baseUrl: `${openemrBase}/apis/${site}/fhir`, ...fhirProxy},
    logLevel,
    session: {
      idleTimeoutMs: idleTimeoutS * 1000,
      maxSessionMs: maxSessionS * 1000,
    },
    build,
  };
}

/** BUG-28: a generous per-call budget (~30 s) and a small upstream cap (≈3–4), both configurable. */
function parseFhirProxy(
  env: Environment,
  fail: Fail,
): Omit<FhirProxyConfig, 'baseUrl'> | undefined {
  const timeoutMs = parseInteger(
    env,
    'BFF_FHIR_TIMEOUT_MS',
    30_000,
    1,
    120_000,
    fail,
  );
  const maxConcurrent = parseInteger(
    env,
    'BFF_FHIR_MAX_CONCURRENT',
    4,
    1,
    256,
    fail,
  );
  const maxConcurrentPerSession = parseInteger(
    env,
    'BFF_FHIR_MAX_CONCURRENT_PER_SESSION',
    3,
    1,
    256,
    fail,
  );
  if (
    timeoutMs === undefined ||
    maxConcurrent === undefined ||
    maxConcurrentPerSession === undefined
  ) {
    return undefined;
  }
  if (maxConcurrentPerSession > maxConcurrent) {
    fail(
      'BFF_FHIR_MAX_CONCURRENT_PER_SESSION',
      'must not exceed BFF_FHIR_MAX_CONCURRENT',
    );
    return undefined;
  }
  return {timeoutMs, maxConcurrent, maxConcurrentPerSession};
}

type Fail = (variable: string, rule: string) => void;

function parseInteger(
  env: Environment,
  variable: string,
  fallback: number,
  min: number,
  max: number,
  fail: Fail,
): number | undefined {
  const raw = env[variable];
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(variable, `must be an integer from ${String(min)} to ${String(max)}`);
    return undefined;
  }
  return value;
}

function parseDistDir(raw: string | undefined, fail: Fail): string | undefined {
  const variable = 'BFF_SPA_DIST_DIR';
  if (raw === undefined || raw === '') {
    fail(variable, 'is required (the SPA build directory, e.g. ../dist)');
    return undefined;
  }
  const dir = path.resolve(raw);
  const index = path.join(dir, 'index.html');
  if (!existsSync(index) || !statSync(index).isFile()) {
    fail(
      variable,
      'must be a directory containing index.html (run the SPA build first)',
    );
    return undefined;
  }
  return dir;
}

/** A bare origin (`scheme://host[:port]`): https, or http on loopback (then the cookie mode must allow it). */
function parseOrigin(raw: string | undefined, fail: Fail): URL | undefined {
  const variable = 'BFF_PUBLIC_ORIGIN';
  if (raw === undefined || raw === '') {
    fail(variable, 'is required (the origin browsers load this service from)');
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(variable, 'must be an absolute http(s) origin');
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail(variable, 'must be an absolute http(s) origin');
    return undefined;
  }
  if (url.origin !== raw) {
    fail(
      variable,
      'must be a bare origin (scheme://host[:port]) with no path, trailing slash, query or fragment',
    );
    return undefined;
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    fail(
      variable,
      'must use https (plain http is accepted only for localhost)',
    );
    return undefined;
  }
  return url;
}

/**
 * `__Host-` cookies need `Secure`, which plain-http development cannot use. The insecure variant is an explicit
 * opt-in, accepted only for an http loopback origin and never with NODE_ENV=production.
 */
function parseCookieMode(
  env: Environment,
  publicOrigin: URL | undefined,
  fail: Fail,
): CookieMode | undefined {
  const variable = 'BFF_DEV_INSECURE_COOKIES';
  const raw = env[variable] ?? 'false';
  if (raw !== 'true' && raw !== 'false') {
    fail(variable, 'must be true or false');
    return undefined;
  }
  const insecure = raw === 'true';
  if (insecure && env.NODE_ENV === 'production') {
    fail(variable, 'must not be true when NODE_ENV is production');
    return undefined;
  }
  if (publicOrigin === undefined) return undefined;
  const plainHttp = publicOrigin.protocol === 'http:';
  if (insecure && !plainHttp) {
    fail(
      variable,
      'is for http://localhost development only; an https BFF_PUBLIC_ORIGIN always uses __Host- Secure cookies',
    );
    return undefined;
  }
  if (!insecure && plainHttp) {
    fail(
      variable,
      'must be true for a plain-http localhost BFF_PUBLIC_ORIGIN (__Host- cookies need https)',
    );
    return undefined;
  }
  return insecure ? 'dev-insecure' : 'host-prefixed';
}

function parseCredential(
  raw: string | undefined,
  variable: string,
  fail: Fail,
): string | undefined {
  if (raw === undefined || raw === '') {
    fail(
      variable,
      'is required (register the client with npm run oauth:register)',
    );
    return undefined;
  }
  if (!CREDENTIAL_PATTERN.test(raw)) {
    fail(variable, 'must be printable characters with no whitespace');
    return undefined;
  }
  return raw;
}

function parseHttpUrl(
  raw: string | undefined,
  variable: string,
  fail: Fail,
): URL | undefined {
  if (raw === undefined || raw === '') {
    fail(variable, 'is required');
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(variable, 'must be an absolute http(s) URL');
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    fail(variable, 'must not embed credentials');
    return undefined;
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  fail(variable, 'must use https (plain http is accepted only for localhost)');
  return undefined;
}
