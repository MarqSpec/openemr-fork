import type {Plugin} from 'vite';

import {precacheUrls} from './precache';

// Build half of the service worker: builds src/pwa/service_worker.ts as a second entry, written unhashed to /sw.js,
// and injects the precache manifest into it once the bundle is final. Hand-written rather than vite-plugin-pwa /
// Workbox: no runtime-caching machinery to switch on by mistake, no second web manifest, no new dependency tree.
// reference: REQUIREMENTS.md FR-PWA-2

/** The free identifier in service_worker.ts that becomes the JSON manifest. */
export const PRECACHE_PLACEHOLDER = '__PRECACHE_MANIFEST__';
export const SERVICE_WORKER_FILE = 'sw.js';
const WORKER_ENTRY_NAME = 'sw';

/** The part of a Rolldown output file the plugin reads (chunks and assets alike). */
export type BundleFile =
  | {
      type: 'chunk';
      readonly fileName: string;
      code: string;
      imports: string[];
    }
  | {
      type: 'asset';
      readonly fileName: string;
      source: string | Uint8Array;
    };

export interface ServiceWorkerBuildOptions {
  readonly input: Record<string, string>;
  readonly entryFileNames: (chunk: {readonly name: string}) => string;
}

/** The app stays `index.html` with hashed names; the worker is a second entry at the root, never hashed. */
export function serviceWorkerBuildOptions(
  entry: string,
): ServiceWorkerBuildOptions {
  return {
    input: {index: 'index.html', [WORKER_ENTRY_NAME]: entry},
    entryFileNames: chunk =>
      chunk.name === WORKER_ENTRY_NAME
        ? SERVICE_WORKER_FILE
        : 'assets/[name]-[hash].js',
  };
}

/**
 * Writes `{cacheName, urls}` into the worker. The cache name hashes every precached file, so any change to the shell
 * makes a byte-different worker, which the browser installs as an update.
 */
export async function injectPrecache(
  bundle: Record<string, BundleFile>,
): Promise<void> {
  const worker = bundle[SERVICE_WORKER_FILE];
  if (worker?.type !== 'chunk') {
    throw new Error(`The build has no ${SERVICE_WORKER_FILE} chunk`);
  }
  if (worker.imports.length > 0) {
    throw new Error(
      `${SERVICE_WORKER_FILE} must not import other chunks (it loads as a classic script)`,
    );
  }
  const occurrences = worker.code.split(PRECACHE_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${SERVICE_WORKER_FILE} must reference ${PRECACHE_PLACEHOLDER} exactly once (found ${String(occurrences)})`,
    );
  }
  const files = Object.values(bundle).filter(
    file => file.fileName !== SERVICE_WORKER_FILE,
  );
  const urls = precacheUrls(files.map(file => file.fileName));
  const cacheName = `openemr-shell-${await digest(urls, files)}`;
  worker.code = worker.code.replace(
    PRECACHE_PLACEHOLDER,
    JSON.stringify({cacheName, urls}),
  );
}

/** The Vite plugin: `precacheServiceWorker({entry: 'src/pwa/service_worker.ts'})`. Build only. */
export function precacheServiceWorker(options: {
  readonly entry: string;
}): Plugin {
  const {input, entryFileNames} = serviceWorkerBuildOptions(options.entry);
  return {
    name: 'openemr-precache-service-worker',
    apply: 'build',
    config: () => ({
      build: {rolldownOptions: {input, output: {entryFileNames}}},
    }),
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        await injectPrecache(bundle);
      },
    },
  };
}

async function digest(
  urls: readonly string[],
  files: readonly BundleFile[],
): Promise<string> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const url of urls) {
    const file = files.find(candidate => `/${candidate.fileName}` === url);
    if (file === undefined) continue;
    parts.push(encoder.encode(`${url}\n`));
    const content = file.type === 'chunk' ? file.code : file.source;
    parts.push(typeof content === 'string' ? encoder.encode(content) : content);
  }
  const total = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    total.set(part, offset);
    offset += part.length;
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', total));
  return [...hash.slice(0, 8)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}
