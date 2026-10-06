import type {IncomingHttpHeaders} from 'node:http';
import type {FastifyReply, FastifyRequest} from 'fastify';

export type Provenance =
  | {allowed: true}
  | {
      allowed: false;
      reason: 'sec_fetch_site' | 'origin_mismatch' | 'no_provenance';
    };

/**
 * FR-BFF-6: `Sec-Fetch-Site` decides when present (only `same-origin` passes); otherwise `Origin` must equal the
 * app's own origin exactly; with neither, the request is refused.
 * reference: REQUIREMENTS.md FR-BFF-6
 */
export function judgeProvenance(
  headers: IncomingHttpHeaders,
  publicOrigin: string,
): Provenance {
  const secFetchSite = headers['sec-fetch-site'];
  if (secFetchSite !== undefined) {
    return secFetchSite === 'same-origin'
      ? {allowed: true}
      : {allowed: false, reason: 'sec_fetch_site'};
  }
  const origin = headers.origin;
  if (origin === undefined) return {allowed: false, reason: 'no_provenance'};
  return origin === publicOrigin
    ? {allowed: true}
    : {allowed: false, reason: 'origin_mismatch'};
}

/** An `onRequest` guard for every state-changing route: it runs before the body is read. */
export function csrfGuard(publicOrigin: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const provenance = judgeProvenance(request.headers, publicOrigin);
    if (!provenance.allowed) {
      request.log.warn(
        {reason: provenance.reason},
        'state-changing request refused (FR-BFF-6)',
      );
      await reply.code(403).send({error: 'forbidden'});
    }
  };
}
