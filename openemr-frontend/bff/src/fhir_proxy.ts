import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {Config} from './config.js';
import {
  FHIR_PROXY_PREFIX,
  matchAllowListed,
  type AllowListedRead,
  type FhirApiId,
} from './fhir_allow_list.js';
import {sessionIdOf} from './session_cookie.js';
import {LimiterBusyError, UpstreamLimiter} from './upstream_limiter.js';

/**
 * API-44: `GET /bff/fhir/{path}` — the allow-listed FHIR read proxy. The bearer token comes from the server-side
 * session only; OpenEMR's status and body pass through; nothing is cached or written anywhere; logs carry method,
 * API-#, status and latency only.
 * reference: INTERFACES.md API-44 · REQUIREMENTS.md FR-BFF-3, FR-BFF-5 · REQUIREMENTS.md BUG-28, BUG-33, BUG-38
 */

/** How a forwarded read ended, counted per API-# (BUG-38: 401, 403 and empty bundles apart from errors). */
export type ProxyOutcome =
  | 'ok'
  | 'empty_bundle'
  | 'unauthorized'
  | 'forbidden'
  | 'client_error'
  | 'server_error'
  | 'timeout'
  | 'upstream_unavailable'
  | 'busy';

/** Why a request was answered without contacting OpenEMR. */
export type RejectReason =
  'not_allow_listed' | 'method_not_allowed' | 'cross_site' | 'no_session';

export interface FhirProxySnapshot {
  byApi: Partial<Record<FhirApiId, Partial<Record<ProxyOutcome, number>>>>;
  rejected: Partial<Record<RejectReason, number>>;
}

/** In-memory counters: no ids, no bodies — only API-# and outcome. */
export class FhirProxyMetrics {
  private readonly byApi = new Map<
    FhirApiId,
    Partial<Record<ProxyOutcome, number>>
  >();
  private readonly rejected: Partial<Record<RejectReason, number>> = {};

  count(apiId: FhirApiId, outcome: ProxyOutcome): void {
    const counters = this.byApi.get(apiId) ?? {};
    counters[outcome] = (counters[outcome] ?? 0) + 1;
    this.byApi.set(apiId, counters);
  }

  reject(reason: RejectReason): void {
    this.rejected[reason] = (this.rejected[reason] ?? 0) + 1;
  }

  snapshot(): FhirProxySnapshot {
    const byApi: FhirProxySnapshot['byApi'] = {};
    for (const [apiId, counters] of this.byApi) byApi[apiId] = {...counters};
    return {byApi, rejected: {...this.rejected}};
  }
}

/**
 * The bearer for a session id, or `undefined` when the session is over (→ 401). In the server it is
 * `app.sessions.getAccessToken` (FR-BFF-4): it refreshes when due and counts the read as activity. A read asks
 * twice: before it queues (no live session, no queue place) and once it holds an upstream slot, for the bearer
 * it sends — so a long queue wait never sends a token that lapsed meanwhile.
 */
export type AccessTokenResolver = (
  sessionId: string,
) => Promise<string | undefined>;

export interface FhirProxyDeps {
  accessToken: AccessTokenResolver;
  metrics: FhirProxyMetrics;
  /** Queue bounds; the defaults are {@link DEFAULT_QUEUE_LIMITS}. */
  queue?: FhirQueueLimits;
}

/** How many reads may wait for an upstream slot, in all and for one session. */
export interface FhirQueueLimits {
  maxQueued: number;
  maxQueuedPerSession: number;
}

/** 256 waiting in all, 32 of them for any one session: past its share, a session gets 503 and no one else does. */
export const DEFAULT_QUEUE_LIMITS: FhirQueueLimits = {
  maxQueued: 256,
  maxQueuedPerSession: 32,
};

/** An empty Bundle is a few hundred bytes; a larger answer is never parsed just to count it (BUG-38). */
const EMPTY_BUNDLE_PARSE_LIMIT = 64 * 1024;

/** An answer larger than this is refused (502): held in memory only, so memory is bounded. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
const FORWARDED_ACCEPT = new Set(['application/fhir+json', 'application/json']);
const JSON_CONTENT_TYPE = /^application\/(?:fhir\+)?json\s*(?:;|$)/i;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

class TooLargeError extends Error {}

export function registerFhirProxy(
  app: FastifyInstance,
  config: Config,
  deps: FhirProxyDeps,
): void {
  const settings = config.fhirProxy;
  const limiter = new UpstreamLimiter({
    maxConcurrent: settings.maxConcurrent,
    maxPerKey: settings.maxConcurrentPerSession,
    maxQueued: (deps.queue ?? DEFAULT_QUEUE_LIMITS).maxQueued,
    maxQueuedPerKey: (deps.queue ?? DEFAULT_QUEUE_LIMITS).maxQueuedPerSession,
  });

  app.route({
    method: METHODS,
    url: `${FHIR_PROXY_PREFIX}*`,
    exposeHeadRoute: false,
    // Before any body is read: reads only.
    onRequest: async (request, reply) => {
      if (request.method === 'GET') return;
      deps.metrics.reject('method_not_allowed');
      logRead(request, apiOf(request), 405, performance.now());
      await reply
        .code(405)
        .header('allow', 'GET')
        .send({error: 'method_not_allowed'});
    },
    handler: async (request, reply) => {
      const started = performance.now();
      const read = matchAllowListed(request.url);
      if (read === undefined) {
        deps.metrics.reject('not_allow_listed');
        logRead(request, undefined, 404, started);
        return reply.code(404).send({error: 'not_found'});
      }

      // A GET changes nothing, so FR-BFF-6's POST guard does not apply; a browser that says the read is not
      // same-origin is refused all the same. Absent (curl, Bruno), the SameSite=Strict cookie is the defence.
      const site = request.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin') {
        deps.metrics.reject('cross_site');
        logRead(request, read.apiId, 403, started);
        return reply.code(403).send({error: 'forbidden'});
      }

      // A read with no live session never queues, so unknown ids cannot fill the queue.
      const sessionId = sessionIdOf(request, config.cookieMode);
      const live =
        sessionId === undefined ? undefined : await deps.accessToken(sessionId);
      if (sessionId === undefined || live === undefined) {
        return unauthenticated(request, reply, read, started);
      }

      const result = await forward(read, sessionId, request);
      if (result.kind === 'no_session') {
        return unauthenticated(request, reply, read, started);
      }
      const status = sendResult(reply, result);
      deps.metrics.count(read.apiId, outcomeOf(read, result));
      logRead(request, read.apiId, status, started);
      return reply;
    },
  });

  function unauthenticated(
    request: FastifyRequest,
    reply: FastifyReply,
    read: AllowListedRead,
    started: number,
  ): FastifyReply {
    deps.metrics.reject('no_session');
    logRead(request, read.apiId, 401, started);
    return reply.code(401).send({error: 'unauthenticated'});
  }

  async function forward(
    read: AllowListedRead,
    sessionId: string,
    request: FastifyRequest,
  ): Promise<ForwardResult | {kind: 'no_session'}> {
    // One budget for the whole read, queue wait included (BUG-28).
    const signal = AbortSignal.timeout(settings.timeoutMs);
    let release: () => void;
    try {
      release = await limiter.acquire(sessionId, signal);
    } catch (error: unknown) {
      return {kind: error instanceof LimiterBusyError ? 'busy' : 'timeout'};
    }
    try {
      // Resolved again once the slot is held: the wait can outlast the refresh margin (60 s) when
      // BFF_FHIR_TIMEOUT_MS is raised, and the session may have ended meanwhile.
      const token = await deps.accessToken(sessionId);
      if (token === undefined) return {kind: 'no_session'};
      return await send(read, token, request, signal);
    } finally {
      release();
    }
  }

  async function send(
    read: AllowListedRead,
    token: string,
    request: FastifyRequest,
    signal: AbortSignal,
  ): Promise<ForwardResult> {
    try {
      const response = await fetch(upstreamUrl(read), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: acceptOf(request),
        },
        // A redirect is never followed: it could carry the bearer token elsewhere.
        redirect: 'error',
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return {kind: 'unavailable'};
      }
      const body = await readBounded(response);
      const contentType = response.headers.get('content-type') ?? '';
      return {kind: 'answer', status: response.status, contentType, body};
    } catch (error: unknown) {
      if (error instanceof TooLargeError) return {kind: 'too_large'};
      return {kind: signal.aborted ? 'timeout' : 'unavailable'};
    }
  }

  function upstreamUrl(read: AllowListedRead): string {
    const query = read.query.toString();
    return `${settings.baseUrl}/${read.path}${query === '' ? '' : `?${query}`}`;
  }
}

type ForwardResult =
  | {kind: 'answer'; status: number; contentType: string; body: Buffer}
  | {kind: 'timeout' | 'unavailable' | 'too_large' | 'busy'};

/** Only status, body and a JSON content type cross from OpenEMR; no other upstream header does. */
function sendResult(reply: FastifyReply, result: ForwardResult): number {
  void reply.header('cache-control', 'no-store');
  switch (result.kind) {
    case 'answer':
      void reply
        .code(result.status)
        // Never HTML (or anything else) from OpenEMR rendered on this origin.
        .header(
          'content-type',
          JSON_CONTENT_TYPE.test(result.contentType)
            ? result.contentType
            : 'text/plain; charset=utf-8',
        )
        .send(result.body);
      return result.status;
    case 'timeout':
      void reply.code(504).send({error: 'upstream_timeout'});
      return 504;
    case 'busy':
      void reply.code(503).send({error: 'busy'});
      return 503;
    case 'unavailable':
    case 'too_large':
      void reply.code(502).send({error: 'upstream_unavailable'});
      return 502;
  }
}

function outcomeOf(read: AllowListedRead, result: ForwardResult): ProxyOutcome {
  switch (result.kind) {
    case 'timeout':
      return 'timeout';
    case 'busy':
      return 'busy';
    case 'unavailable':
    case 'too_large':
      return 'upstream_unavailable';
    case 'answer':
      break;
  }
  const {status} = result;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return read.kind === 'search' && isEmptyBundle(result.body)
    ? 'empty_bundle'
    : 'ok';
}

/** BUG-38: a search that "succeeds" with nothing in it. Only the shape is read; nothing is kept. */
function isEmptyBundle(body: Buffer): boolean {
  if (body.byteLength > EMPTY_BUNDLE_PARSE_LIMIT) return false;
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return false;
  }
  if (typeof json !== 'object' || json === null) return false;
  if (!('resourceType' in json) || json.resourceType !== 'Bundle') return false;
  const entry = 'entry' in json ? json.entry : undefined;
  return !Array.isArray(entry) || entry.length === 0;
}

/** The whole answer in memory, never on disk, and never more than {@link MAX_BODY_BYTES}. */
async function readBounded(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  // Node types a fetch body's chunks as `any`; they are bytes.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      // Not awaited: a cancel can wait on the other side of a tee, and the answer is already decided.
      reader.cancel().catch(() => undefined);
      throw new TooLargeError();
    }
    chunks.push(value);
  }
}

function acceptOf(request: FastifyRequest): string {
  const accept = request.headers.accept;
  return accept !== undefined && FORWARDED_ACCEPT.has(accept)
    ? accept
    : 'application/fhir+json';
}

function apiOf(request: FastifyRequest): FhirApiId | undefined {
  return matchAllowListed(request.url)?.apiId;
}

/** FR-BFF-5: method, API-#, status and latency — never the path, the query, a body or a token. */
function logRead(
  request: FastifyRequest,
  apiId: FhirApiId | undefined,
  status: number,
  started: number,
): void {
  request.log.info(
    {
      method: request.method,
      api: apiId ?? 'none',
      status,
      latencyMs: Math.round(performance.now() - started),
    },
    'fhir proxy',
  );
}
