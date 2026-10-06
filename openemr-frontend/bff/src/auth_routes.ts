import type {CookieSerializeOptions} from '@fastify/cookie';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {createRemoteJWKSet, type JWTVerifyGetKey} from 'jose';
import {z} from 'zod';
import type {Config} from './config.js';
import {csrfGuard} from './csrf.js';
import {DiscoveryError, type DiscoveryClient} from './discovery.js';
import {
  SignInError,
  codeChallenge,
  exchangeCode,
  safeEqual,
  safeErrorCode,
  verifyIdToken,
} from './oauth.js';
import {OAUTH_SCOPES} from './oauth_scopes.js';
import type {Handshake, Session} from './session.js';
import {cookieId, cookieNames, type CookieNames} from './session_cookie.js';
import type {SessionLifecycle} from './session_lifecycle.js';
import {newOpaqueId, type ExpiringStore} from './session_store.js';

/** FR-BFF-1: the handshake lives at most 10 minutes, server-side and in the browser. */
export const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

const SIGNED_OUT = '/signed-out';

/** Closed set of logout reasons the SPA may send; anything else is ignored. */
const LOGOUT_REASONS = new Set(['idle']);

/** Stashed for W-1b when OpenEMR end-session must use the registered URI without a query (BUG-5). */
export const LOGOUT_REASON_COOKIE = 'bff-logout-reason';

const LOGOUT_REASON_COOKIE_TTL_S = 120;

function signedOutPath(reason: string | undefined): string {
  return reason === undefined
    ? SIGNED_OUT
    : `${SIGNED_OUT}?reason=${encodeURIComponent(reason)}`;
}

function logoutReason(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (typeof body !== 'object' || body === null || !('reason' in body)) {
    return undefined;
  }
  const reason = body.reason;
  return typeof reason === 'string' && LOGOUT_REASONS.has(reason)
    ? reason
    : undefined;
}

export interface AuthDeps {
  now: () => number;
  discovery: DiscoveryClient;
  handshakes: ExpiringStore<Handshake>;
  sessions: SessionLifecycle;
}

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(256).optional(),
});

/**
 * API-40 sign-in, API-41 callback, API-43 sign-out — the authorization-code + PKCE flow held server-side.
 * reference: INTERFACES.md API-40, API-41, API-43; REQUIREMENTS.md FR-BFF-1, FR-BFF-2, FR-BFF-6
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  config: Config,
  deps: AuthDeps,
): void {
  const secure = config.cookieMode === 'host-prefixed';
  const names: CookieNames = cookieNames(config.cookieMode);
  const base: CookieSerializeOptions = {httpOnly: true, secure, path: '/'};
  const handshakeCookie: CookieSerializeOptions = {...base, sameSite: 'lax'};
  const sessionCookie: CookieSerializeOptions = {...base, sameSite: 'strict'};
  const redirectUri = `${config.publicOrigin}/bff/callback`;
  const postLogoutRedirectUri = `${config.publicOrigin}${SIGNED_OUT}`;
  const logoutReasonCookie: CookieSerializeOptions = {
    httpOnly: false,
    secure,
    path: '/',
    sameSite: 'lax',
    maxAge: LOGOUT_REASON_COOKIE_TTL_S,
  };
  const guard = csrfGuard(config.publicOrigin);
  const jwksByUri = new Map<string, JWTVerifyGetKey>();
  const jwksFor = (uri: string): JWTVerifyGetKey => {
    let jwks = jwksByUri.get(uri);
    if (jwks === undefined) {
      jwks = createRemoteJWKSet(new URL(uri), {
        timeoutDuration: config.oauth.timeoutMs,
      });
      jwksByUri.set(uri, jwks);
    }
    return jwks;
  };

  // API-40
  app.post('/bff/login', {onRequest: guard}, async (request, reply) => {
    let discovery;
    try {
      discovery = await deps.discovery.get();
    } catch (error: unknown) {
      logDiscoveryFailure(request, error);
      return reply.redirect(`${SIGNED_OUT}?reason=signin_unavailable`, 303);
    }
    const previous = cookieId(request, names.handshake);
    if (previous !== undefined) await deps.handshakes.delete(previous);

    const handshake: Handshake = {
      state: newOpaqueId(),
      nonce: newOpaqueId(),
      codeVerifier: newOpaqueId(),
      createdAt: deps.now(),
    };
    const handshakeId = newOpaqueId();
    await deps.handshakes.set(handshakeId, handshake, HANDSHAKE_TTL_MS);

    const authorize = new URL(discovery.authorizationEndpoint);
    const params = authorize.searchParams;
    params.set('response_type', 'code');
    params.set('client_id', config.oauth.clientId);
    params.set('redirect_uri', redirectUri);
    params.set('scope', OAUTH_SCOPES.join(' '));
    params.set('state', handshake.state);
    params.set('nonce', handshake.nonce);
    params.set('code_challenge', codeChallenge(handshake.codeVerifier));
    params.set('code_challenge_method', 'S256');
    params.set('aud', discovery.audience);

    return reply
      .setCookie(names.handshake, handshakeId, {
        ...handshakeCookie,
        maxAge: HANDSHAKE_TTL_MS / 1000,
      })
      .redirect(authorize.href, 303);
  });

  // API-41: a cross-site top-level GET, so no CSRF guard — state bound to the handshake cookie is the defence.
  app.get('/bff/callback', {exposeHeadRoute: false}, async (request, reply) => {
    // Single use, whatever the outcome.
    void reply.clearCookie(names.handshake, handshakeCookie);
    try {
      const session = await completeSignIn(request);
      const previous = cookieId(request, names.session);
      if (previous !== undefined) await deps.sessions.end(previous);
      const sessionId = await deps.sessions.start(session);
      // No Max-Age: a browser-session cookie; the server-side record bounds the session.
      return await reply
        .setCookie(names.session, sessionId, sessionCookie)
        .redirect('/', 303);
    } catch (error: unknown) {
      if (!(error instanceof SignInError)) throw error;
      request.log.warn(
        {reason: error.reason, detail: error.detail},
        'sign-in rejected',
      );
      return reply.redirect(
        `${SIGNED_OUT}?reason=signin_${error.outcome}`,
        303,
      );
    }
  });

  async function completeSignIn(request: FastifyRequest): Promise<Session> {
    const handshakeId = cookieId(request, names.handshake);
    const handshake =
      handshakeId === undefined
        ? undefined
        : await deps.handshakes.take(handshakeId);
    if (handshake === undefined) {
      throw new SignInError('no_handshake', 'failed');
    }
    if (deps.now() - handshake.createdAt >= HANDSHAKE_TTL_MS) {
      throw new SignInError('handshake_expired', 'failed');
    }
    const query = callbackQuerySchema.safeParse(request.query);
    if (!query.success) throw new SignInError('bad_callback', 'failed');
    const {code, state, error} = query.data;
    if (state === undefined || !safeEqual(state, handshake.state)) {
      throw new SignInError('state_mismatch', 'failed');
    }
    if (error !== undefined) {
      throw new SignInError(
        'authorization_error',
        'failed',
        safeErrorCode(error),
      );
    }
    if (code === undefined) throw new SignInError('no_code', 'failed');

    let discovery;
    try {
      discovery = await deps.discovery.get();
    } catch (failure: unknown) {
      if (!(failure instanceof DiscoveryError)) throw failure;
      throw new SignInError(
        'discovery_unavailable',
        'unavailable',
        failure.reason,
      );
    }
    const tokens = await exchangeCode(discovery, config.oauth, {
      code,
      codeVerifier: handshake.codeVerifier,
      redirectUri,
    });
    const now = deps.now();
    const identity = await verifyIdToken(
      tokens.id_token,
      jwksFor(discovery.jwksUri),
      {
        issuer: discovery.issuer,
        clientId: config.oauth.clientId,
        nonce: handshake.nonce,
        now,
      },
    );
    return {
      subject: identity.subject,
      fhirUser: identity.fhirUser,
      // Omitted scope means "as requested" (RFC 6749 §5.1); consent can narrow it (BUG-20).
      grantedScopes: tokens.scope?.split(' ').filter(s => s !== '') ?? [
        ...OAUTH_SCOPES,
      ],
      tokens: {
        accessToken: tokens.access_token,
        accessTokenExpiresAt: now + tokens.expires_in * 1000,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
      },
      createdAt: now,
      lastActiveAt: now,
    };
  }

  // API-43
  app.post('/bff/logout', {onRequest: guard}, async (request, reply) => {
    const reason = logoutReason(request);
    // Every path but the end-session one clears a lingering reason, so it cannot label this sign-out.
    const clearLogoutReason = (): void => {
      void reply.clearCookie(LOGOUT_REASON_COOKIE, logoutReasonCookie);
    };
    void reply.clearCookie(names.session, sessionCookie);
    const sessionId = cookieId(request, names.session);
    const session =
      sessionId === undefined ? undefined : await deps.sessions.end(sessionId);
    if (session === undefined) {
      clearLogoutReason();
      return reply.redirect(signedOutPath(reason), 303);
    }
    let discovery;
    try {
      discovery = await deps.discovery.get();
    } catch (error: unknown) {
      // The local session is gone, but OpenEMR's may still be open: say so, so the app can warn on a shared tablet.
      logDiscoveryFailure(request, error);
      clearLogoutReason();
      return reply.redirect(`${SIGNED_OUT}?reason=signout_partial`, 303);
    }
    // API-6 needs the id_token itself (BUG-5): post_logout_redirect_uri must match registration exactly — no query.
    if (reason === undefined) {
      clearLogoutReason();
    } else {
      void reply.setCookie(LOGOUT_REASON_COOKIE, reason, logoutReasonCookie);
    }
    const endSession = new URL(discovery.endSessionEndpoint);
    endSession.searchParams.set('id_token_hint', session.tokens.idToken);
    endSession.searchParams.set(
      'post_logout_redirect_uri',
      postLogoutRedirectUri,
    );
    return reply.redirect(endSession.href, 303);
  });

  // State changes are POST-only (FR-BFF-6); the callback is GET-only.
  const methodNotAllowed =
    (allow: string) => (_: FastifyRequest, reply: FastifyReply) =>
      reply
        .code(405)
        .header('allow', allow)
        .send({error: 'method_not_allowed'});
  for (const url of ['/bff/login', '/bff/logout']) {
    app.route({
      method: ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url,
      exposeHeadRoute: false,
      handler: methodNotAllowed('POST'),
    });
  }
  app.route({
    method: ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/bff/callback',
    handler: methodNotAllowed('GET'),
  });
}

function logDiscoveryFailure(request: FastifyRequest, error: unknown): void {
  if (!(error instanceof DiscoveryError)) throw error;
  request.log.warn(
    {reason: error.reason, missingScopes: error.missingScopes},
    'OpenEMR discovery failed',
  );
}
