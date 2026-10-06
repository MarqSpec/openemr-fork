import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {Config} from './config.js';
import {DiscoveryError, type DiscoveryClient} from './discovery.js';
import {fetchDisplayName, practitionerUrl} from './display_name.js';
import type {Session} from './session.js';
import {sessionIdOf} from './session_cookie.js';
import type {SessionLifecycle} from './session_lifecycle.js';

export interface SessionRouteDeps {
  discovery: DiscoveryClient;
  sessions: SessionLifecycle;
}

/**
 * API-42: who is signed in and until when. Reading it is **not** activity — the SPA polls it, and a poll must not
 * keep an unattended tablet signed in — so it neither restarts the idle clock nor needs a fresh token, except once
 * per session to look up the clinician's own name (API-18). Never a token; no PHI but that name.
 * reference: INTERFACES.md API-42; REQUIREMENTS.md FR-BFF-4, FR-UI-3, FR-AUTH-5
 */
export function registerSessionRoute(
  app: FastifyInstance,
  config: Config,
  deps: SessionRouteDeps,
): void {
  const idleTimeoutSeconds = config.session.idleTimeoutMs / 1000;

  app.get('/bff/session', {exposeHeadRoute: false}, async (request, reply) => {
    const id = sessionIdOf(request, config.cookieMode);
    const status = id === undefined ? undefined : await deps.sessions.read(id);
    if (id === undefined || status === undefined) return unauthenticated(reply);
    const displayName = await displayNameFor(request, id, status.session);
    // The look-up may have ended the session (a failed refresh): report what is true now.
    const after = await deps.sessions.read(id);
    if (after === undefined) return unauthenticated(reply);
    return {
      authenticated: true,
      user: {displayName},
      expiresAt: new Date(after.expiresAt).toISOString(),
      idleTimeoutSeconds,
      grantedScopes: after.session.grantedScopes,
    };
  });

  app.route({
    method: ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/bff/session',
    handler: (_request, reply) =>
      reply
        .code(405)
        .header('allow', 'GET')
        .send({error: 'method_not_allowed'}),
  });

  async function displayNameFor(
    request: FastifyRequest,
    id: string,
    session: Session,
  ): Promise<string | null> {
    if (session.displayName !== undefined) return session.displayName;
    let fhirBase: string;
    try {
      fhirBase = (await deps.discovery.get()).audience;
    } catch (error: unknown) {
      if (!(error instanceof DiscoveryError)) throw error;
      request.log.warn({reason: error.reason}, 'display name unavailable');
      return null;
    }
    const url = practitionerUrl(session.fhirUser, fhirBase);
    if (url === undefined) {
      await deps.sessions.rememberDisplayName(id, null);
      return null;
    }
    const token = await deps.sessions.getAccessToken(id, {activity: false});
    if (token === undefined) return null;
    const result = await fetchDisplayName(url, token, config.oauth.timeoutMs);
    if (result.outcome === 'transient') {
      request.log.warn({reason: result.reason}, 'display name unavailable');
      return null;
    }
    await deps.sessions.rememberDisplayName(id, result.displayName);
    return result.displayName;
  }
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({error: 'unauthenticated'});
}
