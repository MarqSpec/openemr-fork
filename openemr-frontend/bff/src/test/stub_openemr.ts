import {createHash, randomBytes} from 'node:crypto';
import {HttpResponse, http, type HttpHandler} from 'msw';
import {
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  type JWK,
} from 'jose';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  OPENEMR_BASE_URL,
  OPENID_DISCOVERY_URL,
  PUBLIC_ORIGIN,
  SMART_DISCOVERY_URL,
} from './fixtures.js';
import {readFileSync} from 'node:fs';

/** A fake OpenEMR authorization server: discovery, JWKS and token endpoint, with its own signing key. */
export const OAUTH_BASE = `${OPENEMR_BASE_URL}/oauth2/default`;
export const FHIR_BASE = `${OPENEMR_BASE_URL}/apis/default/fhir`;
export const AUTHORIZE_URL = `${OAUTH_BASE}/authorize`;
export const TOKEN_URL = `${OAUTH_BASE}/token`;
export const JWKS_URL = `${OAUTH_BASE}/jwk`;
export const END_SESSION_URL = `${OAUTH_BASE}/logout`;
export const STUB_KID = 'stub-signing-key-1';
export const SUBJECT = 'synthetic-user-0001';
export const FHIR_USER = `${FHIR_BASE}/Practitioner/synthetic-practitioner-0001`;
/** The §2 scope list, read from the one machine copy the registration script also reads. */
export const REQUESTED_SCOPES: readonly string[] = readScopesFile();

function readScopesFile(): string[] {
  const file = new URL('../../../config/oauth-scopes.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const scopes: unknown =
    typeof parsed === 'object' && parsed !== null && 'scopes' in parsed
      ? parsed.scopes
      : undefined;
  if (!Array.isArray(scopes)) {
    throw new Error('config/oauth-scopes.json has no scopes list');
  }
  return scopes.map(scope => {
    if (typeof scope !== 'string') throw new Error('a scope is not a string');
    return scope;
  });
}

/** OpenEMR's SMART configuration (API-2): `issuer` is the FHIR base — the `aud` — and scopes are nested (BUG-42). */
export function smartConfiguration(): Record<string, unknown> {
  return {
    issuer: FHIR_BASE,
    jwks_uri: JWKS_URL,
    authorization_endpoint: AUTHORIZE_URL,
    token_endpoint: TOKEN_URL,
    grant_types_supported: ['client_credentials', 'authorization_code'],
    capabilities: ['sso-openid-connect', 'permission-offline'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [[...REQUESTED_SCOPES, 'user/Coverage.read']],
    token_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'private_key_jwt',
    ],
  };
}

/** OpenEMR's OpenID discovery (API-1): the id_token issuer and the end-session endpoint. */
export function openidConfiguration(): Record<string, unknown> {
  return {
    issuer: OAUTH_BASE,
    authorization_endpoint: AUTHORIZE_URL,
    token_endpoint: TOKEN_URL,
    jwks_uri: JWKS_URL,
    end_session_endpoint: END_SESSION_URL,
    scopes_supported: [...REQUESTED_SCOPES],
    code_challenge_methods_supported: ['S256', 'plain'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  };
}

/** How the stub signs one id_token, to drive each rejection path. */
export interface IdTokenPlan {
  /** Claims to set or override (`undefined` removes a claim). */
  claims?: Record<string, unknown>;
  /** `untrusted`: a key the JWKS does not publish, under the published kid — a bad signature. */
  key?: 'trusted' | 'untrusted';
  kid?: string;
  /** PS256 signs with the trusted RSA key, so only the RS256 allow-list refuses it; HS256 uses a shared secret. */
  alg?: 'RS256' | 'PS256' | 'HS256';
  /** The token response's `expires_in`, in seconds. Default 3600, as OpenEMR (BUG-19). */
  expiresIn?: number;
  /** `false`: `offline_access` declined, so the answer carries no refresh token and does not grant that scope. */
  offlineAccess?: boolean;
}

interface IssuedCode {
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  plan: IdTokenPlan;
  used: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

/** How the stub answers the next refresh grants (API-5). */
export type RefreshBehaviour =
  'rotate' | 'invalid_grant' | 'server_error' | 'network_error' | 'malformed';

/** The signed-in clinician's own Practitioner (API-18), synthetic. */
export const PRACTITIONER = {
  resourceType: 'Practitioner',
  id: 'synthetic-practitioner-0001',
  name: [{use: 'official', family: 'Clinician', given: ['Synthetic', 'Q']}],
};

/** One request the stub FHIR server received, as OpenEMR would see it. */
export interface FhirCall {
  url: URL;
  headers: Headers;
}

/** Synthetic PHI planted in the stub's FHIR answers: it must never reach a log line. */
export const PLANTED_NAME = 'Zzyzxsentinel';
export const PLANTED_MRN = 'MRN-SENTINEL-55501';

export interface StubOpenemr {
  handlers: HttpHandler[];
  /** Every request the FHIR server (API-10…24) received, in order — the Practitioner read (API-18) included. */
  fhirRequests: FhirCall[];
  /** FHIR requests being answered right now, and the most at once. */
  fhirInFlight: {now: number; max: number};
  /** How the FHIR server answers; replace it per test. The default is {@link defaultFhirAnswer}. */
  fhirResponder: (call: FhirCall) => Response | Promise<Response>;
  /** Every body the token endpoint received. */
  tokenRequests: URLSearchParams[];
  /** Every token set it issued. */
  issued: IssuedTokens[];
  counts: {smart: number; openid: number; jwks: number; practitioner: number};
  /** Access tokens OpenEMR still honours; a refresh does not revoke the old one (it expires), as OpenEMR. */
  liveAccessTokens: Set<string>;
  /** The refresh tokens OpenEMR still honours: rotation revokes the one used (BUG-19). */
  liveRefreshTokens: Set<string>;
  refreshBehaviour: RefreshBehaviour;
  /** The status the Practitioner read answers with; 200 serves {@link PRACTITIONER}. */
  practitionerStatus: number;
  /** OpenEMR's side of login + consent: reads the authorize URL, returns a one-time code (1-minute life in reality). */
  approve(authorizeLocation: string, plan?: IdTokenPlan): string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export async function createStubOpenemr(): Promise<StubOpenemr> {
  const trusted = await generateKeyPair('RS256', {extractable: true});
  const untrusted = await generateKeyPair('RS256', {extractable: true});
  const publicJwk: JWK = {
    ...(await exportJWK(trusted.publicKey)),
    kid: STUB_KID,
    // No `alg` on the published key: the verifier's own allow-list, not the JWKS, must refuse other algorithms.
    use: 'sig',
  };
  const codes = new Map<string, IssuedCode>();
  const stub: StubOpenemr = {
    handlers: [],
    tokenRequests: [],
    issued: [],
    counts: {smart: 0, openid: 0, jwks: 0, practitioner: 0},
    liveAccessTokens: new Set(),
    liveRefreshTokens: new Set(),
    refreshBehaviour: 'rotate',
    practitionerStatus: 200,
    fhirRequests: [],
    fhirInFlight: {now: 0, max: 0},
    fhirResponder: defaultFhirAnswer,
    approve(authorizeLocation, plan = {}) {
      const url = new URL(authorizeLocation);
      const code = base64url(randomBytes(24));
      codes.set(code, {
        nonce: url.searchParams.get('nonce') ?? '',
        codeChallenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        plan,
        used: false,
      });
      return code;
    },
  };

  async function signIdToken(issued: IssuedCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: OAUTH_BASE,
      aud: CLIENT_ID,
      sub: SUBJECT,
      iat: now,
      exp: now + 3600,
      nonce: issued.nonce,
      fhirUser: FHIR_USER,
      ...issued.plan.claims,
    };
    for (const [name, value] of Object.entries(claims)) {
      if (value === undefined) Reflect.deleteProperty(claims, name);
    }
    const alg = issued.plan.alg ?? 'RS256';
    const header = {alg, kid: issued.plan.kid ?? STUB_KID};
    if (alg === 'HS256') {
      return new SignJWT(claims)
        .setProtectedHeader(header)
        .sign(new TextEncoder().encode('synthetic-shared-secret-32-bytes!!'));
    }
    const rsa =
      issued.plan.key === 'untrusted'
        ? untrusted.privateKey
        : trusted.privateKey;
    const key =
      alg === 'PS256'
        ? await importPKCS8(await exportPKCS8(rsa), 'PS256')
        : rsa;
    return new SignJWT(claims).setProtectedHeader(header).sign(key);
  }

  stub.handlers = [
    http.get(SMART_DISCOVERY_URL, () => {
      stub.counts.smart += 1;
      return HttpResponse.json(smartConfiguration());
    }),
    http.get(OPENID_DISCOVERY_URL, () => {
      stub.counts.openid += 1;
      return HttpResponse.json(openidConfiguration());
    }),
    http.get(JWKS_URL, () => {
      stub.counts.jwks += 1;
      return HttpResponse.json({keys: [publicJwk]});
    }),
    http.post(TOKEN_URL, async ({request}) => {
      const body = new URLSearchParams(await request.text());
      stub.tokenRequests.push(body);
      const invalid = (error: string, status = 400) =>
        HttpResponse.json({error}, {status});
      if (
        body.get('client_id') !== CLIENT_ID ||
        body.get('client_secret') !== CLIENT_SECRET
      ) {
        return invalid('invalid_client', 401);
      }
      if (body.get('grant_type') === 'refresh_token') {
        return refreshGrant(body);
      }
      if (body.get('grant_type') !== 'authorization_code') {
        return invalid('unsupported_grant_type');
      }
      const issued = codes.get(body.get('code') ?? '');
      // A code works once; a replay is invalid_grant, as in OpenEMR.
      if (issued === undefined || issued.used) return invalid('invalid_grant');
      issued.used = true;
      const verifier = body.get('code_verifier') ?? '';
      const challenge = base64url(
        createHash('sha256').update(verifier).digest(),
      );
      if (challenge !== issued.codeChallenge) return invalid('invalid_grant');
      if (body.get('redirect_uri') !== issued.redirectUri) {
        return invalid('invalid_grant');
      }
      const tokens: IssuedTokens = {
        accessToken: `synthetic-access-${base64url(randomBytes(16))}`,
        refreshToken: `synthetic-refresh-${base64url(randomBytes(16))}`,
        idToken: await signIdToken(issued),
      };
      stub.issued.push(tokens);
      stub.liveAccessTokens.add(tokens.accessToken);
      const offline = issued.plan.offlineAccess ?? true;
      if (offline) stub.liveRefreshTokens.add(tokens.refreshToken);
      return HttpResponse.json({
        access_token: tokens.accessToken,
        ...(offline ? {refresh_token: tokens.refreshToken} : {}),
        id_token: tokens.idToken,
        token_type: 'Bearer',
        expires_in: issued.plan.expiresIn ?? 3600,
        scope: REQUESTED_SCOPES.filter(
          scope =>
            scope !== 'user/Appointment.read' &&
            (offline || scope !== 'offline_access'),
        ).join(' '),
      });
    }),
    // Recorded like any FHIR read: the display-name lookup and a proxied API-18 read both land here.
    http.get(FHIR_USER, ({request}) =>
      recordFhir(request, () => practitionerAnswer(request)),
    ),
    // After the discovery handlers and the Practitioner read, which sit under the same FHIR base.
    http.get(`${FHIR_BASE}/*`, ({request}) =>
      recordFhir(request, call => stub.fhirResponder(call)),
    ),
  ];

  /** Records one FHIR request as OpenEMR saw it and tracks how many are in flight while it is answered. */
  async function recordFhir(
    request: Request,
    answer: (call: FhirCall) => Response | Promise<Response>,
  ): Promise<Response> {
    const call: FhirCall = {
      url: new URL(request.url),
      headers: request.headers,
    };
    stub.fhirRequests.push(call);
    stub.fhirInFlight.now += 1;
    stub.fhirInFlight.max = Math.max(
      stub.fhirInFlight.max,
      stub.fhirInFlight.now,
    );
    try {
      return await answer(call);
    } finally {
      stub.fhirInFlight.now -= 1;
    }
  }

  function practitionerAnswer(request: Request): Response {
    stub.counts.practitioner += 1;
    const bearer = /^Bearer (.+)$/.exec(
      request.headers.get('authorization') ?? '',
    )?.[1];
    if (bearer === undefined || !stub.liveAccessTokens.has(bearer)) {
      return new HttpResponse(null, {status: 401});
    }
    if (stub.practitionerStatus !== 200) {
      return HttpResponse.json(
        {resourceType: 'OperationOutcome'},
        {status: stub.practitionerStatus},
      );
    }
    return HttpResponse.json(PRACTITIONER, {
      headers: {'content-type': 'application/fhir+json'},
    });
  }

  /** API-5 as OpenEMR does it: the used refresh token is revoked and a new one issued (BUG-19). */
  function refreshGrant(body: URLSearchParams): Response {
    const behaviour = stub.refreshBehaviour;
    if (behaviour === 'network_error') return Response.error();
    if (behaviour === 'server_error') {
      return HttpResponse.json({error: 'server_error'}, {status: 500});
    }
    const used = body.get('refresh_token') ?? '';
    if (behaviour === 'invalid_grant' || !stub.liveRefreshTokens.has(used)) {
      return HttpResponse.json({error: 'invalid_grant'}, {status: 400});
    }
    stub.liveRefreshTokens.delete(used);
    const tokens: IssuedTokens = {
      accessToken: `synthetic-access-${base64url(randomBytes(16))}`,
      refreshToken: `synthetic-refresh-${base64url(randomBytes(16))}`,
      idToken: `synthetic-refreshed-id-token-${base64url(randomBytes(16))}`,
    };
    stub.issued.push(tokens);
    stub.liveAccessTokens.add(tokens.accessToken);
    stub.liveRefreshTokens.add(tokens.refreshToken);
    if (behaviour === 'malformed') {
      return HttpResponse.json({token_type: 'Bearer'});
    }
    return HttpResponse.json({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      id_token: tokens.idToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: REQUESTED_SCOPES.filter(scope => !scope.startsWith('api:')).join(
        ' ',
      ),
    });
  }
  return stub;
}

/** A read returns the resource; a search returns a one-entry Bundle. Both carry the planted name and MRN. */
export function defaultFhirAnswer(call: FhirCall): Response {
  const [type = '', id] = call.url.pathname
    .slice(new URL(FHIR_BASE).pathname.length + 1)
    .split('/');
  const resource = {
    resourceType: type,
    id: id ?? 'synthetic-0001',
    name: [{family: PLANTED_NAME}],
    identifier: [{value: PLANTED_MRN}],
  };
  if (type === 'metadata') {
    return HttpResponse.json(
      {resourceType: 'CapabilityStatement', status: 'active'},
      {headers: {'content-type': 'application/fhir+json'}},
    );
  }
  const body =
    id === undefined
      ? {
          resourceType: 'Bundle',
          type: 'collection',
          total: 1,
          entry: [{resource}],
        }
      : resource;
  return HttpResponse.json(body, {
    headers: {'content-type': 'application/fhir+json'},
  });
}

/** The registered redirect and post-logout URIs for the fixture origin (runbook, FR-AUTH-6). */
export const REDIRECT_URI = `${PUBLIC_ORIGIN}/bff/callback`;
export const POST_LOGOUT_REDIRECT_URI = `${PUBLIC_ORIGIN}/signed-out`;
