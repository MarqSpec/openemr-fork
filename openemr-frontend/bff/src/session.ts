/**
 * The pre-auth state API-40 creates and API-41 consumes, keyed by the handshake cookie. Server-side only: the
 * browser holds the opaque key, never these values (NFR-SEC-1).
 */
export interface Handshake {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

/** The OAuth tokens a session holds, server-side only (FR-BFF-2). */
export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: number;
  /** Present when `offline_access` was granted (BUG-19); replaced by each rotation (API-5). */
  refreshToken: string | undefined;
  /** The sign-in id_token, kept for API-6's `id_token_hint` (BUG-5): a refresh never replaces it, since OpenEMR matches its nonce. */
  idToken: string;
}

/**
 * A signed-in session, keyed by the session cookie. `createdAt` starts the maximum session length and
 * `lastActiveAt` the inactivity timeout (FR-BFF-4, `session_lifecycle.ts`).
 */
export interface Session {
  subject: string;
  fhirUser: string | undefined;
  grantedScopes: readonly string[];
  tokens: SessionTokens;
  createdAt: number;
  lastActiveAt: number;
  /** The clinician's own name for API-42, looked up once (API-18); `null` when it could not be; absent until then. */
  displayName?: string | null;
}
