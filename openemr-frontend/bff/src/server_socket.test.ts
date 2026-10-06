// A real listening socket on loopback: shutdown and HTTP-parser errors happen below `inject()`.
// No MSW here — nothing in this file calls OpenEMR.
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import net from 'node:net';
import type {AddressInfo} from 'node:net';
import {buildServer} from './server.js';
import {makeSpaDist, testConfig} from './test/fixtures.js';

// Real sockets: the first listen on a cold CI runner can take seconds. The shutdown assertions carry their own 2 s bounds.
vi.setConfig({testTimeout: 15_000});

/** Planted in each refused request; the answer must never repeat it. */
const PLANTED = 'SYNTHETIC-ECHO-SENTINEL-4410';

let dist: Awaited<ReturnType<typeof makeSpaDist>>;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  dist = await makeSpaDist();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await dist.cleanup();
});

async function listen(
  extraRoutes?: (server: FastifyInstance) => void,
): Promise<{server: FastifyInstance; port: number}> {
  const server = buildServer(testConfig(dist.dir));
  extraRoutes?.(server);
  await server.listen({port: 0, host: '127.0.0.1'});
  app = server;
  return {server, port: (server.server.address() as AddressInfo).port};
}

/** Writes raw bytes and returns everything the server sends back before it closes the connection. */
function rawExchange(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
    socket.setEncoding('utf8');
    socket.on('data', chunk => (received += String(chunk)));
    // 'close' as well as 'end': the server destroys the socket after answering, and a reset can skip 'end'.
    socket.on('end', () => {
      resolve(received);
    });
    socket.on('close', () => {
      resolve(received);
    });
    socket.on('error', error => {
      if (received === '') reject(error);
    });
  });
}

/** Status line and lower-cased headers of a raw HTTP/1.1 response. */
function parseHead(raw: string): {
  status: number;
  headers: Map<string, string>;
} {
  const [head = ''] = raw.split('\r\n\r\n');
  const [statusLine = '', ...lines] = head.split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return {status: Number(statusLine.split(' ')[1]), headers};
}

function expectSecurityHeaders(headers: {get(name: string): unknown}): void {
  expect(String(headers.get('content-security-policy'))).toContain(
    "default-src 'self'",
  );
  expect(String(headers.get('content-security-policy'))).toContain(
    "connect-src 'self'",
  );
  expect(String(headers.get('strict-transport-security'))).toMatch(
    /max-age=\d+/,
  );
  expect(headers.get('referrer-policy')).toBe('same-origin');
  expect(headers.get('x-content-type-options')).toBe('nosniff');
}

describe('given a request the HTTP parser rejects before Fastify routes it', () => {
  it.each([
    [
      'a request line that is not HTTP',
      `GARBAGE-${PLANTED}\r\n\r\n`,
      400,
      'malformed_request',
    ],
    [
      'a non-numeric Content-Length',
      `GET /bff/health?q=${PLANTED} HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${PLANTED}\r\n\r\n`,
      400,
      'malformed_request',
    ],
    [
      'headers larger than the parser allows',
      `GET /?q=${PLANTED} HTTP/1.1\r\nHost: localhost\r\nX-Synthetic: ${PLANTED}${'a'.repeat(20_000)}\r\n\r\n`,
      431,
      'too_large',
    ],
    [
      'chunk extensions larger than the parser allows',
      `POST /bff/test-body?q=${PLANTED} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1;${PLANTED}=${'a'.repeat(20_000)}\r\nx\r\n0\r\n\r\n`,
      413,
      'too_large',
    ],
  ])(
    'when it sends %s, then the error response carries the NFR-SEC-2 headers and a reason, and repeats none of the request',
    async (_, bytes, status, reason) => {
      // A body the handler waits for, so only the parser can answer the chunk-extensions case.
      const {port} = await listen(server => {
        server.post('/bff/test-body', request => request.body);
      });

      const raw = await rawExchange(port, bytes);
      const response = parseHead(raw);

      expect(response.status).toBe(status);
      expectSecurityHeaders(response.headers);
      expect(response.headers.get('connection')).toBe('close');
      expect(JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4))).toEqual({
        error: reason,
      });
      expect(raw).not.toContain(PLANTED);
    },
  );

  it("when a request's headers do not arrive within the server's timeout, then Node's 408 is answered \"request_timeout\" with the headers, and repeats none of the request", async () => {
    // Node checks request deadlines on an interval read at listen(): shorten both so the real timeout fires fast.
    const {port} = await listen(server => {
      // Not in @types/node's Server type, but read from the instance when listen() starts the check.
      Object.assign(server.server, {connectionsCheckingInterval: 50});
      server.server.headersTimeout = 200;
      server.server.requestTimeout = 200;
    });

    const raw = await rawExchange(
      port,
      `GET /?q=${PLANTED} HTTP/1.1\r\nHost: localhost\r\nX-Synthetic: ${PLANTED}\r\n`,
    );
    const response = parseHead(raw);

    expect(response.status).toBe(408);
    expectSecurityHeaders(response.headers);
    expect(response.headers.get('connection')).toBe('close');
    expect(JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4))).toEqual({
      error: 'request_timeout',
    });
    expect(raw).not.toContain(PLANTED);
  });

  it('when clients send garbage and then hold their half of the connection open, then the server drops every one and close() is not held up', async () => {
    const {server, port} = await listen();
    const clients = await Promise.all(
      Array.from({length: 5}, () => openHalfOpenGarbageClient(port)),
    );

    expect(await openConnectionsWithin(server, 0, 2000)).toBe(0);
    expect(await settlesWithin(server.close(), 2000)).toBe(true);
    app = undefined;
    for (const client of clients) client.destroy();
  });
});

describe('given the token handler is shutting down (SIGTERM on every redeploy)', () => {
  it('when a new request reaches the router while shutdown is under way, then its 503 carries the NFR-SEC-2 headers and closes the connection', async () => {
    let releaseClose: () => void = () => undefined;
    const {server, port} = await listen(routes => {
      // Holds shutdown between "closing" and the listener closing, so a fresh request still gets in.
      routes.addHook(
        'preClose',
        () =>
          new Promise<void>(resolve => {
            releaseClose = resolve;
          }),
      );
    });

    const closing = server.close();
    await new Promise(resolve => setImmediate(resolve));
    const response = parseHead(
      await rawExchange(
        port,
        'GET /bff/health HTTP/1.1\r\nHost: localhost\r\n\r\n',
      ),
    );
    releaseClose();
    await closing;
    app = undefined;

    expect(response.status).toBe(503);
    expectSecurityHeaders(response.headers);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('connection')).toBe('close');
  });

  it('when a request is in flight as shutdown starts, then its response closes the connection and close() returns promptly', async () => {
    let releaseSlow: () => void = () => undefined;
    let slowEntered: () => void = () => undefined;
    const entered = new Promise<void>(resolve => {
      slowEntered = resolve;
    });
    let shutdownStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      shutdownStarted = resolve;
    });
    const {server, port} = await listen(routes => {
      // Runs after the token handler's own preClose hook, so "closing" is already set.
      routes.addHook('preClose', done => {
        shutdownStarted();
        done();
      });
      routes.get(
        '/bff/test-slow',
        () =>
          new Promise(resolve => {
            releaseSlow = () => {
              resolve({ok: true});
            };
            slowEntered();
          }),
      );
    });
    let received = '';
    const socket = net.connect({port, host: '127.0.0.1', allowHalfOpen: true});
    socket.setEncoding('utf8');
    const responded = new Promise<void>(resolve => {
      socket.on('data', chunk => {
        received += String(chunk);
        if (received.includes('{"ok":true}')) resolve();
      });
    });
    socket.on('error', () => undefined);
    // A keep-alive client: it would happily reuse the connection.
    socket.write(
      'GET /bff/test-slow HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n',
    );
    await entered;

    const closing = server.close();
    await started;
    releaseSlow();
    await responded;
    const closedPromptly = await settlesWithin(closing, 2000);
    socket.destroy();
    app = undefined;

    expect(parseHead(received).status).toBe(200);
    expect(parseHead(received).headers.get('connection')).toBe('close');
    expect(closedPromptly).toBe(true);
  });
});

/** A client that sends one malformed request and never closes its side. */
async function openHalfOpenGarbageClient(port: number): Promise<net.Socket> {
  const socket = net.connect({port, host: '127.0.0.1', allowHalfOpen: true});
  socket.on('data', () => undefined);
  socket.on('error', () => undefined);
  await new Promise<void>(resolve => {
    socket.on('connect', () => {
      resolve();
    });
  });
  const answered = new Promise<void>(resolve => {
    socket.on('end', () => {
      resolve();
    });
  });
  socket.write('GARBAGE\r\n\r\n');
  await answered;
  return socket;
}

function connectionCount(server: FastifyInstance): Promise<number> {
  return new Promise((resolve, reject) => {
    server.server.getConnections((error, count) => {
      if (error) reject(error);
      else resolve(count);
    });
  });
}

/** Polls the server's open-connection count until it reaches `target` or `withinMs` passes. */
async function openConnectionsWithin(
  server: FastifyInstance,
  target: number,
  withinMs: number,
): Promise<number> {
  const deadline = Date.now() + withinMs;
  let count = await connectionCount(server);
  while (count !== target && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    count = await connectionCount(server);
  }
  return count;
}

async function settlesWithin(
  promise: Promise<unknown>,
  withinMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => {
      resolve(false);
    }, withinMs);
  });
  const settled = await Promise.race([promise.then(() => true), timeout]);
  clearTimeout(timer);
  return settled;
}
