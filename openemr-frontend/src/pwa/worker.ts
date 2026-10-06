import {SHELL_PATH, routeFor} from './precache';

// The service worker's behaviour, with its platform passed in so it runs under test; `service_worker.ts` wires it
// to `self`. No runtime caching: the only write to Cache Storage is the install-time `addAll` of the precache.
// reference: REQUIREMENTS.md FR-PWA-2, FR-PWA-3, FR-PWA-4, NFR-SEC-1

export const SHELL_URL = SHELL_PATH;
/** The message the page sends when the clinician taps Reload; nothing else makes a waiting worker take over. */
export const SKIP_WAITING = 'SKIP_WAITING';

/** Injected into the built worker by the precache plugin. */
export interface PrecacheManifest {
  readonly cacheName: string;
  readonly urls: readonly string[];
}

export interface WorkerContext {
  readonly caches: CacheStorage;
  /** The network, for navigations and precache misses; its responses are never stored. */
  readonly network: (request: Request) => Promise<Response>;
  readonly skipWaiting: () => Promise<void>;
  readonly origin: string;
  readonly manifest: PrecacheManifest;
}

/** Fetches every precache entry past the HTTP cache into this version's cache. Does not skip waiting. */
export async function installShell(ctx: WorkerContext): Promise<void> {
  const cache = await ctx.caches.open(ctx.manifest.cacheName);
  await cache.addAll(
    ctx.manifest.urls.map(
      url => new Request(new URL(url, ctx.origin), {cache: 'reload'}),
    ),
  );
}

/** Deletes every cache but this version's, so Cache Storage holds exactly the precache. */
export async function activateShell(ctx: WorkerContext): Promise<void> {
  const names = await ctx.caches.keys();
  await Promise.all(
    names
      .filter(name => name !== ctx.manifest.cacheName)
      .map(name => ctx.caches.delete(name)),
  );
}

/** The response for a request, or `undefined` to leave it to the browser untouched (every `/bff` request). */
export function handleFetch(
  ctx: WorkerContext,
  request: Request,
): Promise<Response> | undefined {
  const route = routeFor(request, ctx.origin, new Set(ctx.manifest.urls));
  switch (route) {
    case 'network':
      return undefined;
    case 'precache':
      return fromPrecache(ctx, request.url).then(
        cached => cached ?? ctx.network(request),
      );
    case 'shell':
      // Online, the server's page (no-store, a new deploy at once); offline, the precached one.
      return ctx.network(request).catch(async (error: unknown) => {
        const shell = await fromPrecache(ctx, SHELL_URL);
        if (shell === undefined) throw error;
        return shell;
      });
  }
}

/** Skips waiting only when the page asks with {@link SKIP_WAITING}; `undefined` for anything else. */
export function handleMessage(
  ctx: WorkerContext,
  data: unknown,
): Promise<void> | undefined {
  const asked =
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === SKIP_WAITING;
  return asked ? ctx.skipWaiting() : undefined;
}

async function fromPrecache(
  ctx: WorkerContext,
  url: string,
): Promise<Response | undefined> {
  const cache = await ctx.caches.open(ctx.manifest.cacheName);
  return cache.match(new URL(url, ctx.origin).href);
}
