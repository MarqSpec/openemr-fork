import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {Config} from './config.js';
import {csrfGuard} from './csrf.js';
import {sessionIdOf} from './session_cookie.js';
import type {SessionLifecycle} from './session_lifecycle.js';

const ACTIVITY_PATH = '/bff/session/activity';

/**
 * API-46: "Stay signed in". Restarts the session's idle clock (never past the 10 h maximum) and answers only the new
 * expiry. It changes state, so it is POST-only behind the FR-BFF-6 guard like sign-in and sign-out; it never calls
 * OpenEMR and carries no patient data. No live session — none, unknown, or already ended — is a 401, never a revival.
 * reference: INTERFACES.md API-46; REQUIREMENTS.md FR-AUTH-4, FR-BFF-4, FR-BFF-6; REQUIREMENTS.md Q-2;
 */
export function registerSessionActivityRoute(
  app: FastifyInstance,
  config: Config,
  sessions: SessionLifecycle,
): void {
  app.post(
    ACTIVITY_PATH,
    {onRequest: csrfGuard(config.publicOrigin)},
    async (request, reply) => {
      const id = sessionIdOf(request, config.cookieMode);
      const status =
        id === undefined ? undefined : await sessions.recordActivity(id);
      if (status === undefined) {
        return reply.code(401).send({error: 'unauthenticated'});
      }
      return {expiresAt: new Date(status.expiresAt).toISOString()};
    },
  );

  app.route({
    method: ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: ACTIVITY_PATH,
    exposeHeadRoute: false,
    handler: (_request: FastifyRequest, reply: FastifyReply) =>
      reply
        .code(405)
        .header('allow', 'POST')
        .send({error: 'method_not_allowed'}),
  });
}
