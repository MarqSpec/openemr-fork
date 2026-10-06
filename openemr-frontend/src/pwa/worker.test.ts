// @vitest-environment node
import {describe, expect, it, vi} from 'vitest';

import {SKIP_WAITING_MESSAGE} from './update';
import {
  SHELL_URL,
  SKIP_WAITING,
  activateShell,
  handleFetch,
  handleMessage,
  installShell,
  type WorkerContext,
} from './worker';

// reference: REQUIREMENTS.md FR-PWA-2, FR-PWA-3, FR-PWA-4, NFR-SEC-1

const ORIGIN = 'https://dashboard.example.test';
const MANIFEST = {
  cacheName: 'openemr-shell-abc123',
  urls: ['/assets/index-Bq1x2y3z.js', '/index.html'],
};

/** An in-memory Cache Storage: enough of the API for the worker, and inspectable by the test. */
class FakeCaches {
  readonly stores = new Map<string, Map<string, Response>>();
  readonly added: Request[] = [];

  open(name: string): Promise<Cache> {
    let store = this.stores.get(name);
    if (store === undefined) {
      store = new Map();
      this.stores.set(name, store);
    }
    const entries = store;
    const added = this.added;
    const cache = {
      addAll: (requests: Request[]) => {
        for (const request of requests) {
          added.push(request);
          const path = new URL(request.url, ORIGIN).pathname;
          entries.set(path, new Response(`body ${path}`));
        }
        return Promise.resolve();
      },
      match: (request: RequestInfo) => {
        const url = typeof request === 'string' ? request : request.url;
        return Promise.resolve(
          entries.get(new URL(url, ORIGIN).pathname)?.clone(),
        );
      },
      put: () => Promise.reject(new Error('the worker must never put')),
      add: () => Promise.reject(new Error('the worker must never add')),
    };
    return Promise.resolve(cache as unknown as Cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }

  has(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.has(name));
  }

  match(): Promise<Response | undefined> {
    return Promise.reject(new Error('the worker names its cache'));
  }
}

function context(network: (request: Request) => Promise<Response>) {
  const caches = new FakeCaches();
  const skipWaiting = vi.fn(() => Promise.resolve());
  const ctx: WorkerContext = {
    caches,
    network,
    skipWaiting,
    origin: ORIGIN,
    manifest: MANIFEST,
  };
  return {ctx, caches, skipWaiting};
}

const online = (request: Request) =>
  Promise.resolve(new Response(`network ${new URL(request.url).pathname}`));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

function request(path: string, init: RequestInit = {}) {
  return new Request(`${ORIGIN}${path}`, init);
}

/** A navigation request; `mode: 'navigate'` cannot be set through the Request constructor. */
function navigation(path: string): Request {
  const inner = request(path);
  return new Proxy(inner, {
    get: (target, property) =>
      property === 'mode'
        ? 'navigate'
        : (Reflect.get(target, property, target) as unknown),
  });
}

describe('given a new service worker installing', () => {
  it('when it installs, then its cache holds exactly the precache manifest, fetched past the HTTP cache', async () => {
    const {ctx, caches} = context(online);

    await installShell(ctx);

    expect([...caches.stores.keys()]).toEqual([MANIFEST.cacheName]);
    expect([...(caches.stores.get(MANIFEST.cacheName)?.keys() ?? [])]).toEqual(
      MANIFEST.urls,
    );
    expect(caches.added.map(added => added.cache)).toEqual(
      MANIFEST.urls.map(() => 'reload'),
    );
  });

  it('when it installs, then it does not skip waiting on its own (guards a swap mid-session, FR-PWA-3)', async () => {
    const {ctx, skipWaiting} = context(online);

    await installShell(ctx);

    expect(skipWaiting).not.toHaveBeenCalled();
  });
});

describe('given a service worker activating', () => {
  it('when it activates, then every other cache in the origin is deleted, so Cache Storage holds exactly its precache', async () => {
    const {ctx, caches} = context(online);
    caches.stores.set('openemr-shell-old', new Map());
    caches.stores.set(
      'something-else',
      new Map([['/bff/session', new Response('x')]]),
    );
    await installShell(ctx);

    await activateShell(ctx);

    expect([...caches.stores.keys()]).toEqual([MANIFEST.cacheName]);
  });
});

describe('given an active service worker answering requests', () => {
  it('when the page reads /bff/session, then the worker does not answer it at all (guards a clinical response reaching Cache Storage)', async () => {
    const network = vi.fn(online);
    const {ctx, caches} = context(network);
    await installShell(ctx);

    expect(handleFetch(ctx, request('/bff/session'))).toBeUndefined();
    expect(handleFetch(ctx, request('/bff/fhir/Patient/1'))).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
    expect([...(caches.stores.get(MANIFEST.cacheName)?.keys() ?? [])]).toEqual(
      MANIFEST.urls,
    );
  });

  it('when a precached asset is requested, then it comes from the precache without the network', async () => {
    const network = vi.fn(online);
    const {ctx} = context(network);
    await installShell(ctx);

    const response = await handleFetch(
      ctx,
      request('/assets/index-Bq1x2y3z.js'),
    );

    expect(await response?.text()).toBe('body /assets/index-Bq1x2y3z.js');
    expect(network).not.toHaveBeenCalled();
  });

  it('when a page is opened online, then it comes from the network, not the precache (guards a stale shell and no-store)', async () => {
    const {ctx} = context(online);
    await installShell(ctx);

    const response = await handleFetch(ctx, navigation('/'));

    expect(await response?.text()).toBe('network /');
  });

  it('when a page is opened offline, then the precached shell answers it (FR-PWA-4)', async () => {
    let connected = true;
    const {ctx} = context(req => (connected ? online(req) : offline()));
    await installShell(ctx);
    connected = false;

    const response = await handleFetch(ctx, navigation('/signed-out'));

    expect(await response?.text()).toBe(`body ${SHELL_URL}`);
  });

  it('when a page is opened offline and nothing was precached, then the network error stands', async () => {
    const {ctx} = context(offline);

    await expect(handleFetch(ctx, navigation('/'))).rejects.toThrow(TypeError);
  });

  it('when a file outside the precache is requested, then the worker leaves it to the network and stores nothing', async () => {
    const {ctx, caches} = context(online);
    await installShell(ctx);

    expect(handleFetch(ctx, request('/manifest.webmanifest'))).toBeUndefined();
    expect(
      handleFetch(ctx, request('/bff/logout', {method: 'POST'})),
    ).toBeUndefined();
    expect([...(caches.stores.get(MANIFEST.cacheName)?.keys() ?? [])]).toEqual(
      MANIFEST.urls,
    );
  });
});

describe('given a waiting service worker', () => {
  it('when the page asks it to take over, then it skips waiting (the user chose Reload, FR-PWA-3)', async () => {
    const {ctx, skipWaiting} = context(online);

    await handleMessage(ctx, {type: SKIP_WAITING});

    expect(skipWaiting).toHaveBeenCalledOnce();
  });

  it('when any other message arrives, then it keeps waiting', () => {
    const {ctx, skipWaiting} = context(online);

    expect(handleMessage(ctx, 'SKIP_WAITING')).toBeUndefined();
    expect(handleMessage(ctx, {type: 'CLAIM'})).toBeUndefined();
    expect(handleMessage(ctx, null)).toBeUndefined();
    expect(skipWaiting).not.toHaveBeenCalled();
  });

  it('when the page and the worker name the take-over message, then they agree (guards a Reload that never swaps)', () => {
    expect(SKIP_WAITING_MESSAGE).toEqual({type: SKIP_WAITING});
  });
});
