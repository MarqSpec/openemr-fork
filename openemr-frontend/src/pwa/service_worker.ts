import {
  activateShell,
  handleFetch,
  handleMessage,
  installShell,
  type PrecacheManifest,
  type WorkerContext,
} from './worker';

// The worker entry, built to /sw.js by precache_plugin.ts. Wiring only: behaviour lives in worker.ts. This is the
// one file outside src/api/ that may fetch (eslint.config.mjs): it serves the app shell and never answers /bff.
// No skipWaiting on install and no clients.claim: a new version waits until the clinician taps Reload (FR-PWA-3).
// reference: REQUIREMENTS.md FR-PWA-2, FR-PWA-3, FR-PWA-4

/** Replaced with the JSON precache manifest when the bundle is written. */
declare const __PRECACHE_MANIFEST__: PrecacheManifest;

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: unknown;
}

/** The slice of ServiceWorkerGlobalScope the worker uses (the DOM lib the app compiles with has no worker scope). */
interface WorkerScope {
  readonly location: {readonly origin: string};
  readonly caches: CacheStorage;
  fetch(request: Request): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableEvent) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(
    type: 'message',
    listener: (event: ExtendableMessageEvent) => void,
  ): void;
}

declare const self: WorkerScope;

const ctx: WorkerContext = {
  caches: self.caches,
  network: request => self.fetch(request),
  skipWaiting: () => self.skipWaiting(),
  origin: self.location.origin,
  manifest: __PRECACHE_MANIFEST__,
};

self.addEventListener('install', event => {
  event.waitUntil(installShell(ctx));
});

self.addEventListener('activate', event => {
  event.waitUntil(activateShell(ctx));
});

self.addEventListener('fetch', event => {
  const response = handleFetch(ctx, event.request);
  if (response !== undefined) event.respondWith(response);
});

self.addEventListener('message', event => {
  const done = handleMessage(ctx, event.data);
  if (done !== undefined) event.waitUntil(done);
});
