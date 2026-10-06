import {z} from 'zod';
import type {Config} from './config.js';
import {OAUTH_SCOPES} from './oauth_scopes.js';

/** What sign-in and sign-out need from OpenEMR, read from its discovery documents — never built from a base URL. */
export interface Discovery {
  /** API-3 (SMART). */
  authorizationEndpoint: string;
  /** API-4 (SMART). */
  tokenEndpoint: string;
  /** API-7 (SMART). */
  jwksUri: string;
  /** The FHIR base, sent as `aud` at authorize: SMART's `issuer` (BUG-17). */
  audience: string;
  /** The id_token issuer: OpenID discovery's `issuer`, `{site_addr_oath}/oauth2/{site}`. */
  issuer: string;
  /** API-6 (OpenID): SMART configuration does not advertise it. */
  endSessionEndpoint: string;
}

export type DiscoveryFailure =
  | 'unreachable'
  | 'timeout'
  | 'upstream_status'
  | 'invalid_discovery'
  | 'scope_unsupported'
  | 'origin_mismatch';

/** Carries a reason code and, for `scope_unsupported`, the scope names — never an upstream body. */
export class DiscoveryError extends Error {
  constructor(
    readonly reason: DiscoveryFailure,
    readonly missingScopes: readonly string[] = [],
  ) {
    super(`OpenEMR discovery failed: ${reason}`);
    this.name = 'DiscoveryError';
  }
}

const CACHE_MS = 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const endpoint = z.url().refine(value => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  );
});

const smartSchema = z.object({
  issuer: endpoint,
  authorization_endpoint: endpoint,
  token_endpoint: endpoint,
  jwks_uri: endpoint,
  code_challenge_methods_supported: z
    .array(z.string())
    .refine(methods => methods.includes('S256')),
  scopes_supported: z.unknown().optional(),
});

const openidSchema = z.object({
  issuer: endpoint,
  end_session_endpoint: endpoint,
});

/**
 * `scopes_supported` as a flat list: flat, or nested one array deep as OpenEMR's SMART document is (BUG-42).
 * Anything else — missing, an object, a string, a non-string entry — is `undefined`.
 */
export function flattenScopes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const flat: unknown[] = value.flat();
  return flat.every(scope => typeof scope === 'string') ? flat : undefined;
}

export interface DiscoveryClient {
  get(): Promise<Discovery>;
}

/**
 * API-2 (SMART, authoritative for SMART behaviour — BUG-4) and API-1 (OpenID) together, cached for an hour.
 * A failure is not cached.
 */
export function createDiscovery(
  config: Config,
  deps: {now: () => number},
): DiscoveryClient {
  let cached: {discovery: Discovery; until: number} | undefined;
  return {
    async get() {
      if (cached !== undefined && cached.until > deps.now()) {
        return cached.discovery;
      }
      const discovery = await load(config);
      cached = {discovery, until: deps.now() + CACHE_MS};
      return discovery;
    },
  };
}

async function load(config: Config): Promise<Discovery> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.oauth.timeoutMs);
  let documents: [unknown, unknown];
  try {
    documents = await Promise.all([
      fetchJson(config.smartDiscoveryUrl, controller.signal),
      fetchJson(config.openidDiscoveryUrl, controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const smart = smartSchema.safeParse(documents[0]);
  const openid = openidSchema.safeParse(documents[1]);
  if (!smart.success || !openid.success) {
    throw new DiscoveryError('invalid_discovery');
  }

  // BUG-11: no list to check is a refusal, never a skipped check.
  const supported = flattenScopes(smart.data.scopes_supported);
  if (supported === undefined) throw new DiscoveryError('invalid_discovery');
  const missing = OAUTH_SCOPES.filter(scope => !supported.includes(scope));
  if (missing.length > 0) {
    throw new DiscoveryError('scope_unsupported', missing);
  }

  // CSP form-action governs where a form post may redirect: both browser hops must stay on that origin.
  for (const url of [
    smart.data.authorization_endpoint,
    openid.data.end_session_endpoint,
  ]) {
    if (new URL(url).origin !== config.authorizeOrigin) {
      throw new DiscoveryError('origin_mismatch');
    }
  }

  return {
    authorizationEndpoint: smart.data.authorization_endpoint,
    tokenEndpoint: smart.data.token_endpoint,
    jwksUri: smart.data.jwks_uri,
    audience: smart.data.issuer,
    issuer: openid.data.issuer,
    endSessionEndpoint: openid.data.end_session_endpoint,
  };
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {Accept: 'application/json'},
      redirect: 'error',
      signal,
    });
  } catch {
    throw new DiscoveryError(signal.aborted ? 'timeout' : 'unreachable');
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new DiscoveryError('upstream_status');
  }
  try {
    return await response.json();
  } catch {
    throw new DiscoveryError(signal.aborted ? 'timeout' : 'invalid_discovery');
  }
}
