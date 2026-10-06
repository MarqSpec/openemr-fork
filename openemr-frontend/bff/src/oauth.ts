import {createHash, timingSafeEqual} from 'node:crypto';
import {errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey} from 'jose';
import {z} from 'zod';
import type {OAuthClientConfig} from './config.js';
import type {Discovery} from './discovery.js';

/** Why a sign-in was refused. `unavailable` means OpenEMR could not be asked; `failed`, that it said no. */
export class SignInError extends Error {
  constructor(
    readonly reason: string,
    readonly outcome: 'failed' | 'unavailable',
    /** Safe detail for the log only: an OAuth error code or a claim name, never a value or a body. */
    readonly detail?: string,
  ) {
    super(`sign-in ${outcome}: ${reason}`);
    this.name = 'SignInError';
  }
}

export type RefreshFailure =
  'refresh_rejected' | 'refresh_unavailable' | 'refresh_invalid_response';

/** Why a refresh (API-5) failed; any failure ends the session. `detail` is an OAuth error code or a status, never a body. */
export class RefreshError extends Error {
  constructor(
    readonly reason: RefreshFailure,
    readonly detail?: string,
  ) {
    super(`refresh failed: ${reason}`);
    this.name = 'RefreshError';
  }
}

/** PKCE S256: the challenge sent to authorize for a verifier kept server-side (BUG-16). */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Constant-time equality for state and nonce. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

/** An OAuth `error` code is an enum and safe to log; anything else is dropped. */
export function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && OAUTH_ERROR_CODE.test(value)
    ? value
    : undefined;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  token_type: z.string().refine(type => type.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** API-4: the authorization-code exchange as a confidential client (`client_secret_post`, BUG-4). */
export async function exchangeCode(
  discovery: Discovery,
  client: OAuthClientConfig,
  request: {code: string; codeVerifier: string; redirectUri: string},
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    code_verifier: request.codeVerifier,
    client_id: client.clientId,
    client_secret: client.clientSecret.reveal(),
  });
  const signal = AbortSignal.timeout(client.timeoutMs);
  let response: Response;
  try {
    response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'error',
      signal,
    });
  } catch {
    throw new SignInError(
      signal.aborted ? 'token_timeout' : 'token_unreachable',
      'unavailable',
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  if (response.status >= 500) {
    throw new SignInError(
      'token_endpoint_status',
      'unavailable',
      String(response.status),
    );
  }
  if (!response.ok) {
    const error =
      typeof json === 'object' && json !== null && 'error' in json
        ? safeErrorCode(json.error)
        : undefined;
    throw new SignInError(
      'token_rejected',
      'failed',
      error ?? String(response.status),
    );
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new SignInError('token_response_invalid', 'failed');
  }
  return parsed.data;
}

const refreshResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine(type => type.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
});

/** What a refresh yields; the id_token OpenEMR also returns is ignored (BUG-5 needs the sign-in one). */
export interface RefreshedTokens {
  accessToken: string;
  expiresInSeconds: number;
  /** The rotated refresh token; OpenEMR revokes the one just used (BUG-19). */
  refreshToken: string | undefined;
}

/**
 * API-5: `grant_type=refresh_token` as the confidential client. No `scope`: omitted means "as originally granted"
 * (RFC 6749 §6), whereas OpenEMR's echoed `scope` drops `api:` scopes and must be identical (BUG-19).
 */
export async function refreshAccessToken(
  discovery: Discovery,
  client: OAuthClientConfig,
  refreshToken: string,
): Promise<RefreshedTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret.reveal(),
  });
  const signal = AbortSignal.timeout(client.timeoutMs);
  let response: Response;
  try {
    response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'error',
      signal,
    });
  } catch {
    throw new RefreshError(
      'refresh_unavailable',
      signal.aborted ? 'timeout' : 'unreachable',
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  if (response.status >= 500) {
    throw new RefreshError('refresh_unavailable', String(response.status));
  }
  if (!response.ok) {
    const error =
      typeof json === 'object' && json !== null && 'error' in json
        ? safeErrorCode(json.error)
        : undefined;
    throw new RefreshError(
      'refresh_rejected',
      error ?? String(response.status),
    );
  }
  const parsed = refreshResponseSchema.safeParse(json);
  if (!parsed.success) throw new RefreshError('refresh_invalid_response');
  return {
    accessToken: parsed.data.access_token,
    expiresInSeconds: parsed.data.expires_in,
    refreshToken: parsed.data.refresh_token,
  };
}

/** Claims the session keeps from a validated id_token. */
export interface IdentityClaims {
  subject: string;
  fhirUser: string | undefined;
}

/** jose errors that mean the token is bad, as opposed to the JWKS being unreachable. */
const INVALID_TOKEN_CODES = new Set([
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

/** A 60-second skew allowance, and an id_token must be fresh: it is minted by the exchange just made. */
const CLOCK_TOLERANCE_S = 60;
const MAX_TOKEN_AGE_S = 300;

/**
 * Validates the id_token: RS256 signature from OpenEMR's JWKS (API-7), `iss`, `aud` = client id, `exp`, `iat`,
 * `sub`, and the `nonce` this sign-in sent (FR-AUTH-1, FR-BFF-2).
 */
export async function verifyIdToken(
  idToken: string,
  keys: JWTVerifyGetKey,
  expected: {issuer: string; clientId: string; nonce: string; now: number},
): Promise<IdentityClaims> {
  let payload: JWTPayload;
  try {
    ({payload} = await jwtVerify(idToken, keys, {
      issuer: expected.issuer,
      audience: expected.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
      currentDate: new Date(expected.now),
      clockTolerance: CLOCK_TOLERANCE_S,
      maxTokenAge: MAX_TOKEN_AGE_S,
    }));
  } catch (error: unknown) {
    // Never log the error itself: jose attaches the decoded claims (nonce, sub) to it.
    if (
      error instanceof errors.JOSEError &&
      INVALID_TOKEN_CODES.has(error.code)
    ) {
      const claim =
        error instanceof errors.JWTClaimValidationFailed
          ? error.claim
          : undefined;
      throw new SignInError('id_token_invalid', 'failed', claim ?? error.code);
    }
    throw new SignInError('jwks_unavailable', 'unavailable');
  }
  if (
    typeof payload.nonce !== 'string' ||
    !safeEqual(payload.nonce, expected.nonce)
  ) {
    throw new SignInError('id_token_invalid', 'failed', 'nonce');
  }
  if (payload.sub === undefined || payload.sub === '') {
    throw new SignInError('id_token_invalid', 'failed', 'sub');
  }
  const fhirUser = payload.fhirUser;
  return {
    subject: payload.sub,
    fhirUser: typeof fhirUser === 'string' ? fhirUser : undefined,
  };
}
