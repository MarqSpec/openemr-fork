import type {FastifyRequest} from 'fastify';
import type {CookieMode} from './config.js';

const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;

export interface CookieNames {
  session: string;
  handshake: string;
}

/** `__Host-`: Secure, Path=/, no Domain — the browser enforces all three for the prefix (FR-BFF-1). */
export function cookieNames(mode: CookieMode): CookieNames {
  return mode === 'host-prefixed'
    ? {session: '__Host-bff-session', handshake: '__Host-bff-handshake'}
    : {session: 'bff-session', handshake: 'bff-handshake'};
}

/** A cookie's value if it has the shape of an id this service minted; anything else is ignored unread. */
export function cookieId(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.cookies[name];
  return value !== undefined && OPAQUE_ID.test(value) ? value : undefined;
}

/** The session id the request's cookie carries, for any `/bff/*` route that needs the session (API-42, API-44). */
export function sessionIdOf(
  request: FastifyRequest,
  mode: CookieMode,
): string | undefined {
  return cookieId(request, cookieNames(mode).session);
}
