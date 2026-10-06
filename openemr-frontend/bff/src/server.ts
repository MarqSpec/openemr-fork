import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {STATUS_CODES} from 'node:http';
import type {Socket} from 'node:net';
import path from 'node:path';
import {registerAuthRoutes} from './auth_routes.js';
import type {Config} from './config.js';
import {DiscoveryError, createDiscovery} from './discovery.js';
import {
  FhirProxyMetrics,
  registerFhirProxy,
  type AccessTokenResolver,
  type FhirQueueLimits,
} from './fhir_proxy.js';
import {refreshAccessToken, RefreshError} from './oauth.js';
import {createReadinessProbe} from './readiness.js';
import {securityHeaders} from './security_headers.js';
import type {Handshake, Session} from './session.js';
import {registerSessionActivityRoute} from './session_activity.js';
import {SessionLifecycle} from './session_lifecycle.js';
import {registerSessionRoute} from './session_route.js';
import {MemoryStore} from './session_store.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The session lifecycle (FR-BFF-4) for any `/bff/*` route that acts for the signed-in user: the FHIR proxy
     * calls `getAccessToken(id)` with the id from `sessionIdOf` — it refreshes when due and counts as activity.
     */
    sessions: SessionLifecycle;
  }
}

const BFF_PREFIX = '/bff';
const BFF_NAMESPACE = /^\/bff(?:[/;]|$)/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
// max-age=0 as well: Railway's CDN keeps static content types for its default TTL unless max-age overrides it.
const REVALIDATE = 'no-cache, max-age=0';
// The page is never stored; after sign-out's cookie change Chromium also won't restore it from bfcache.
// A service worker's Cache Storage is not the HTTP cache: its install-time precache still holds the offline shell.
const NO_STORE = 'no-store';
const SHELL_FILE = 'index.html';

/** Cap on each in-memory store; the oldest entry goes first beyond it. */
const MAX_STORE_ENTRIES = 10_000;

/** Seams for tests: the clock (handshake expiry, token times) and where log lines go. */
export interface ServerDeps {
  now?: () => number;
  logStream?: {write: (line: string) => void};
  /** API-44's BUG-38 counters; pass one in to read them. */
  fhirMetrics?: FhirProxyMetrics;
  /** Test seam for API-44's bearer source; the server uses `sessions.getAccessToken`. */
  accessToken?: AccessTokenResolver;
  /** API-44's queue bounds, smaller in tests; the defaults otherwise. */
  fhirQueue?: FhirQueueLimits;
}

/** The token handler: the built SPA at `/` and its own routes under `/bff/*`, one origin (FR-BFF-1). */
export function buildServer(
  config: Config,
  deps: ServerDeps = {},
): FastifyInstance {
  const now = deps.now ?? Date.now;
  const headers = securityHeaders(config.authorizeOrigin);
  let closing = false;
  const app = Fastify({
    // Fastify's own closing 503 is written raw, without the headers; the onRequest hook below answers instead.
    return503OnClosing: false,
    // On close, drop idle keep-alive connections at once (onSend below closes the busy ones as they finish).
    forceCloseConnections: 'idle',
    // Node's HTTP parser rejects some requests before Fastify sees them; answer those with the headers too.
    clientErrorHandler: (error, socket) => {
      writeClientError(error, socket, headers);
    },
    // A malformed URL is rejected before routing, so no hook runs: set the headers here too.
    frameworkErrors: (_error, _request, reply: FastifyReply) => {
      void reply
        .headers(headers)
        .code(400)
        .send({error: clientErrorReason(400)});
    },
    logger: {
      level: config.logLevel,
      ...(deps.logStream === undefined ? {} : {stream: deps.logStream}),
      // FR-BFF-5: method and path only — a query string can carry identifiers.
      serializers: {
        req: (request: {method: string; url: string}) => ({
          method: request.method,
          path: loggablePath(request.url),
        }),
      },
    },
  });

  app.addHook('preClose', done => {
    closing = true;
    done();
  });
  // Draining: a request on a still-open keep-alive connection gets a 503 that tells the client to go elsewhere.
  app.addHook('onRequest', async (_request, reply) => {
    if (closing) {
      await reply
        .code(503)
        .header('connection', 'close')
        .send({error: 'shutting_down'});
    }
  });

  // Odd spellings of /bff (case, %2f, `;`, `//`, `\`) route to the static handler, not ours: stop them here.
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url ?? '';
    if (isBffPath(request.url) && !route.startsWith(BFF_PREFIX)) {
      await notFound(reply);
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.headers(headers);
    if (isBffPath(request.url)) reply.header('cache-control', 'no-store');
    // Once shutdown starts, no response keeps its connection alive, so close() never waits out keep-alive.
    if (closing) reply.header('connection', 'close');
    return payload;
  });

  app.setErrorHandler((error: {statusCode?: number}, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      if (!isListedClientError(status)) {
        // A new path raised a 4xx with no reason of its own: answer it, and say so.
        request.log.warn({statusCode: status}, 'unlisted client error status');
      }
      return reply.code(status).send({error: clientErrorReason(status)});
    }
    request.log.error({err: error}, 'request failed');
    return reply.code(500).send({error: 'internal'});
  });

  app.setNotFoundHandler((request, reply) => {
    if (isSpaRoute(request)) {
      return reply.header('cache-control', NO_STORE).sendFile(SHELL_FILE);
    }
    return notFound(reply);
  });

  void app.register(fastifyCookie);
  // Sign-in and sign-out are form posts: accept urlencoded bodies (usually empty; logout may carry reason=idle).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    {parseAs: 'string', bodyLimit: 1024},
    (_request, body, done) => {
      if (typeof body !== 'string' || body === '') {
        done(null, undefined);
        return;
      }
      done(null, Object.fromEntries(new URLSearchParams(body)));
    },
  );
  const discovery = createDiscovery(config, {now});
  const sessionStore = new MemoryStore<Session>({
    maxEntries: MAX_STORE_ENTRIES,
    now,
  });
  const sessions = new SessionLifecycle({
    store: sessionStore,
    now,
    policy: config.session,
    refresh: async refreshToken => {
      let endpoints;
      try {
        endpoints = await discovery.get();
      } catch (error: unknown) {
        if (!(error instanceof DiscoveryError)) throw error;
        throw new RefreshError('refresh_unavailable', error.reason);
      }
      return refreshAccessToken(endpoints, config.oauth, refreshToken);
    },
    log: app.log,
  });
  app.decorate('sessions', sessions);
  registerAuthRoutes(app, config, {
    now,
    discovery,
    handshakes: new MemoryStore<Handshake>({
      maxEntries: MAX_STORE_ENTRIES,
      now,
    }),
    sessions,
  });
  // reference: INTERFACES.md API-44
  registerFhirProxy(app, config, {
    accessToken: deps.accessToken ?? (id => sessions.getAccessToken(id)),
    metrics: deps.fhirMetrics ?? new FhirProxyMetrics(),
    ...(deps.fhirQueue === undefined ? {} : {queue: deps.fhirQueue}),
  });
  registerSessionRoute(app, config, {discovery, sessions});
  // reference: INTERFACES.md API-46
  registerSessionActivityRoute(app, config, sessions);

  // reference: INTERFACES.md API-45
  // The build id lets a post-deploy check tell the new deployment from the one it replaced.
  app.get(`${BFF_PREFIX}/health`, () => ({status: 'ok', build: config.build}));
  // Monotonic, not `now`: a wall-clock step must not stretch or cut the cache window.
  const readinessProbe = createReadinessProbe(
    config.smartDiscoveryUrl,
    config.readyTimeoutMs,
    {now: () => performance.now()},
  );
  app.get(`${BFF_PREFIX}/ready`, async (_request, reply) => {
    const readiness = await readinessProbe.check();
    if (readiness.ready) return {status: 'ready'};
    return reply
      .code(503)
      .send({status: 'not_ready', reason: readiness.reason});
  });
  // Anything else under /bff is a 404 and never falls through to the SPA or the disk.
  app.all(BFF_PREFIX, (_request, reply) => notFound(reply));
  app.all(`${BFF_PREFIX}/*`, (_request, reply) => notFound(reply));

  void app.register(fastifyStatic, {
    root: config.spaDistDir,
    cacheControl: false,
    // A dotfile in the build output (.env, .git) is never content: 404, as if absent.
    dotfiles: 'ignore',
    setHeaders: (reply, filePath) => {
      const relative = path.relative(config.spaDistDir, filePath);
      // Vite fingerprints everything under assets/; the page is never stored; the rest must revalidate.
      void reply.header('cache-control', cacheControlFor(relative));
    },
  });

  return app;
}

/** The build file's `Cache-Control`, by its path relative to the build folder (bff/README.md serving table). */
function cacheControlFor(relative: string): string {
  if (relative === SHELL_FILE) return NO_STORE;
  return relative.startsWith(`assets${path.sep}`) ? IMMUTABLE : REVALIDATE;
}

/**
 * The reason each 4xx the token handler answers itself names: a closed set, chosen by status alone, so nothing of the
 * request is ever repeated back. Every 4xx the token handler answers today is listed, and 429, which a future limit
 * would raise; `malformed_request` means 400 alone.
 */
const CLIENT_ERROR_REASONS = {
  400: 'malformed_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  408: 'request_timeout',
  413: 'too_large',
  414: 'too_large',
  415: 'unsupported_media_type',
  429: 'too_many_requests',
  431: 'too_large',
} as const;

type ListedClientErrorStatus = keyof typeof CLIENT_ERROR_REASONS;

/** Any other 4xx: named as a client error, never as a malformed request, and logged as a gap. */
const UNLISTED_CLIENT_ERROR = 'client_error';

export type ClientErrorReason =
  | (typeof CLIENT_ERROR_REASONS)[ListedClientErrorStatus]
  | typeof UNLISTED_CLIENT_ERROR;

function isListedClientError(
  status: number,
): status is ListedClientErrorStatus {
  return Object.hasOwn(CLIENT_ERROR_REASONS, status);
}

/** Node's own status for the parser errors it does not answer with 400. */
const PARSER_ERROR_STATUS: Readonly<Record<string, ListedClientErrorStatus>> = {
  HPE_HEADER_OVERFLOW: 431,
  HPE_CHUNK_EXTENSIONS_OVERFLOW: 413,
  ERR_HTTP_REQUEST_TIMEOUT: 408,
};

/** The reason a 4xx names ({@link CLIENT_ERROR_REASONS}); `client_error` for a 4xx no path raises today. */
export function clientErrorReason(status: number): ClientErrorReason {
  return isListedClientError(status)
    ? CLIENT_ERROR_REASONS[status]
    : UNLISTED_CLIENT_ERROR;
}

/** A minimal raw response for a request the HTTP parser refused; the connection is not reusable after it. */
function writeClientError(
  error: Error & {code?: string},
  socket: Socket,
  headers: Record<string, string>,
): void {
  if (error.code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }
  const status: ListedClientErrorStatus =
    PARSER_ERROR_STATUS[error.code ?? ''] ?? 400;
  const body = JSON.stringify({error: clientErrorReason(status)});
  const lines = [
    `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}`,
    'content-type: application/json; charset=utf-8',
    `content-length: ${String(Buffer.byteLength(body))}`,
    'cache-control: no-store',
    'connection: close',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  // end() alone leaves a half-open socket for as long as the client holds its side; destroy once flushed.
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`, () => {
    socket.destroy();
  });
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({error: 'not_found'});
}

function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** FR-BFF-5: a FHIR proxy path carries patient ids, so none of it is logged beyond the prefix. */
function loggablePath(url: string): string {
  const target = originFormOf(url);
  return /^\/bff\/fhir(?:[/;]|$)/.test(normalizePath(target).toLowerCase())
    ? '/bff/fhir/{path}'
    : pathOf(target);
}

/** An absolute-form target (`http://host/path`, RFC 9112 §3.2.2) as its path; any other target unchanged. */
function originFormOf(url: string): string {
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(url);
  if (absolute === null) return url;
  const rest = url.slice(absolute[0].length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** The path as a file system or a lenient proxy might read it: percent-decoded, `\` and `//` as one `/`. */
function normalizePath(url: string): string {
  let urlPath = pathOf(url);
  try {
    urlPath = decodeURIComponent(urlPath);
  } catch {
    // Malformed escapes: judge the raw path.
  }
  return urlPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/**
 * The token handler's namespace, judged on the normalized, case-folded path: `/BFF/x`, `/bff%2fx`,
 * `/bff;x/y` and `//bff/x` are all inside it, so they are 404s, never the SPA shell or a file.
 */
function isBffPath(url: string): boolean {
  return BFF_NAMESPACE.test(normalizePath(url).toLowerCase());
}

/** A client-side route (e.g. `/signed-out`): a GET for a path with no file extension. */
function isSpaRoute(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (isBffPath(request.url)) return false;
  const urlPath = normalizePath(request.url);
  const lastSegment = urlPath.slice(urlPath.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}
