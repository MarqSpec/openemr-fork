// What the service worker may hold, and which requests it may answer. Pure, so the worker, the build plugin and the
// tests share one definition. reference: REQUIREMENTS.md FR-PWA-2, FR-PWA-4, NFR-SEC-1

/** The page the offline shell opens; every navigation falls back to it when the network is gone. */
export const SHELL_PATH = '/index.html';

/**
 * The precache: `index.html` and Vite's fingerprinted output under `assets/` — nothing else. Not the worker itself,
 * source maps, the manifest or icons (unhashed, served `no-cache`, not needed to open the shell).
 */
export function precacheUrls(fileNames: readonly string[]): string[] {
  if (!fileNames.includes('index.html')) {
    throw new Error('The build has no index.html to precache');
  }
  return fileNames
    .filter(
      name =>
        name === 'index.html' ||
        (name.startsWith('assets/') && !name.endsWith('.map')),
    )
    .map(name => `/${name}`)
    .sort();
}

/**
 * True for the token handler's namespace, judged as the token handler judges it (bff/README.md): percent-decoded,
 * case-folded, `\` and repeated `/` read as one `/`. A path with a bad percent-escape (`/bff/%zz`) cannot be decoded,
 * so it is judged raw, as the token handler judges it — it is still a `/bff` path, and the worker never answers it.
 */
export function isBffPath(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes: judge the raw path (bff/src/server.ts normalizePath).
  }
  const normal = decoded.toLowerCase().replace(/[\\/]+/g, '/');
  return /^\/bff(?:[/;]|$)/.test(normal);
}

/** What the worker does with a request: answer from the precache, network-then-shell, or not answer at all. */
export type Route = 'precache' | 'shell' | 'network';

export interface RequestFacts {
  readonly method: string;
  readonly url: string;
  readonly mode: string;
}

/**
 * `network` means the worker does not call `respondWith`: the browser fetches as if there were no worker, and
 * nothing is stored. Every `/bff` request, every non-GET and every other origin is `network`.
 */
export function routeFor(
  request: RequestFacts,
  origin: string,
  precached: ReadonlySet<string>,
): Route {
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== origin ||
    isBffPath(url.pathname)
  ) {
    return 'network';
  }
  if (request.mode === 'navigate') return 'shell';
  return url.search === '' && precached.has(url.pathname)
    ? 'precache'
    : 'network';
}
