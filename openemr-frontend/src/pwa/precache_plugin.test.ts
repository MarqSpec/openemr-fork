// @vitest-environment node
import {describe, expect, it} from 'vitest';

import {
  PRECACHE_PLACEHOLDER,
  SERVICE_WORKER_FILE,
  injectPrecache,
  serviceWorkerBuildOptions,
  type BundleFile,
} from './precache_plugin';

// reference: REQUIREMENTS.md FR-PWA-2

const WORKER_CODE = `const m=${PRECACHE_PLACEHOLDER};self.addEventListener("install",()=>m);`;

function bundle(workerCode = WORKER_CODE): Record<string, BundleFile> {
  return {
    'index.html': {
      type: 'asset',
      fileName: 'index.html',
      source: '<html>1</html>',
    },
    'assets/index-Bq1x2y3z.js': {
      type: 'chunk',
      fileName: 'assets/index-Bq1x2y3z.js',
      code: 'console.log(1)',
      imports: [],
    },
    'assets/index-C4d5e6f7.css': {
      type: 'asset',
      fileName: 'assets/index-C4d5e6f7.css',
      source: new Uint8Array([98, 111, 100, 121]),
    },
    [SERVICE_WORKER_FILE]: {
      type: 'chunk',
      fileName: SERVICE_WORKER_FILE,
      code: workerCode,
      imports: [],
    },
  };
}

function injectedManifest(files: Record<string, BundleFile>): unknown {
  const worker = files[SERVICE_WORKER_FILE];
  if (worker?.type !== 'chunk') throw new Error('no worker chunk');
  const match = /const m=(\{.*?\});/.exec(worker.code);
  return JSON.parse(match?.[1] ?? 'null');
}

describe('given the build options the plugin adds', () => {
  it('when Vite builds, then the worker is a second entry written unhashed at the root as sw.js, and the app keeps hashed names', () => {
    const options = serviceWorkerBuildOptions('src/pwa/service_worker.ts');

    expect(options.input).toEqual({
      index: 'index.html',
      sw: 'src/pwa/service_worker.ts',
    });
    expect(options.entryFileNames({name: 'sw'})).toBe('sw.js');
    expect(options.entryFileNames({name: 'index'})).toBe(
      'assets/[name]-[hash].js',
    );
  });
});

describe('given a finished bundle', () => {
  it('when the precache is injected, then the worker carries exactly the page and the fingerprinted assets', async () => {
    const files = bundle();

    await injectPrecache(files);

    expect(injectedManifest(files)).toEqual({
      cacheName: expect.stringMatching(
        /^openemr-shell-[0-9a-f]{16}$/,
      ) as string,
      urls: [
        '/assets/index-Bq1x2y3z.js',
        '/assets/index-C4d5e6f7.css',
        '/index.html',
      ],
    });
  });

  it('when any shell file changes, then the cache name changes, so the new worker is a real update', async () => {
    const before = bundle();
    const after = bundle();
    const page = after['index.html'];
    if (page?.type === 'asset') page.source = '<html>2</html>';

    await injectPrecache(before);
    await injectPrecache(after);

    const name = (files: Record<string, BundleFile>) =>
      (injectedManifest(files) as {cacheName: string}).cacheName;
    expect(name(after)).not.toBe(name(before));
  });

  it('when the worker has no placeholder, then the build fails (guards a worker that precaches nothing)', async () => {
    await expect(injectPrecache(bundle('self.x=1;'))).rejects.toThrow(
      PRECACHE_PLACEHOLDER,
    );
  });

  it('when the worker imports a shared chunk, then the build fails (guards a worker that cannot load as a classic script)', async () => {
    const files = bundle();
    const worker = files[SERVICE_WORKER_FILE];
    if (worker?.type === 'chunk') worker.imports = ['assets/shared-X.js'];

    await expect(injectPrecache(files)).rejects.toThrow(/import/);
  });

  it('when there is no worker chunk, then the build fails', async () => {
    const files = bundle();
    Reflect.deleteProperty(files, SERVICE_WORKER_FILE);

    await expect(injectPrecache(files)).rejects.toThrow(SERVICE_WORKER_FILE);
  });
});
