import {defineConfig} from '@playwright/test';

// Local tier: Chromium against the built app on a `vite preview` that Playwright starts itself, every run — or,
// with E2E_SERVER=dev, the tablet projects against a Vite dev server for quick local iteration.
// Staging tier: staging-only specs against the deployed SPA when STAGING_BASE_URL is set.
// REQUIREMENTS.md NFR-TEST-2, NFR-COMPAT-1

// Never attach to a server this run did not start: another clone's server on the same port would be tested in
// place of this checkout's code. A port in use fails the run instead; parallel clones pick their own
// ports. The defaults are off Vite's 5173/4173, so a running `npm run dev` or preview does not collide.
// Kept as the digit string it was given (template-literal safe), once it is known to be a valid port.
function e2ePort(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || port < 1024 || port > 65535) {
    throw new Error(`${name} must be a port from 1024 to 65535, got "${raw}"`);
  }
  return raw;
}
const DEV_PORT = e2ePort('E2E_DEV_PORT', '5273');
const PREVIEW_PORT = e2ePort('E2E_PREVIEW_PORT', '4273');
if (DEV_PORT === PREVIEW_PORT) {
  throw new Error(
    `E2E_DEV_PORT and E2E_PREVIEW_PORT must differ, both are ${DEV_PORT}`,
  );
}
const DEV_URL = `http://localhost:${DEV_PORT}`;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;

// The dev server compiles each module on first request, so under a loaded runner the first specs' page loads ran
// past Playwright's 30 s timeouts; the build is compiled once, before any spec. CI and the default local
// run use it. E2E_SERVER=dev puts the tablet projects on the dev server (no rebuild per run, HMR for --ui).
function e2eServer(): 'preview' | 'dev' {
  const raw = process.env.E2E_SERVER;
  if (raw === undefined || raw === '' || raw === 'preview') return 'preview';
  if (raw === 'dev') return 'dev';
  throw new Error(`E2E_SERVER must be "preview" or "dev", got "${raw}"`);
}
const ON_DEV = e2eServer() === 'dev';
const BASE_URL = ON_DEV ? DEV_URL : PREVIEW_URL;
// The build registers a service worker; the dev server never does, and the tablet specs were written
// without one. Blocked there, so a worker cannot serve what a spec routes; the pwa and bfcache projects own it.
const TABLET_SERVICE_WORKERS = ON_DEV ? 'allow' : 'block';
const BFCACHE_SPEC = /bfcache\.spec\.ts$/;
// The service worker is registered only by the production build, so its spec needs `vite preview` too.
const PWA_SPEC = /service_worker\.spec\.ts$/;
const PREVIEW_ONLY = [BFCACHE_SPEC, PWA_SPEC];

// Staging tier: the deployed SPA URL, set by CI. Staging projects are excluded when unset.
const STAGING_BASE_URL = process.env.STAGING_BASE_URL;
const STAGING_SPEC = /staging[\\/]/;
// CI staging runs set PLAYWRIGHT_NO_WEBSERVER=1 so a local build failure cannot block remote specs.
const SKIP_WEBSERVER = process.env.PLAYWRIGHT_NO_WEBSERVER === '1';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: true,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    hasTouch: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'tablet-landscape',
      testIgnore: [...PREVIEW_ONLY, STAGING_SPEC],
      use: {
        viewport: {width: 1280, height: 800},
        serviceWorkers: TABLET_SERVICE_WORKERS,
      },
    },
    {
      name: 'tablet-portrait',
      testIgnore: [...PREVIEW_ONLY, STAGING_SPEC],
      use: {
        viewport: {width: 800, height: 1280},
        serviceWorkers: TABLET_SERVICE_WORKERS,
      },
    },
    {
      // Back/forward cache ON: Playwright passes --disable-back-forward-cache by default and its headless
      // shell refuses the cache, so this project drops the switch and runs full Chromium (`channel: 'chromium'`),
      // against the built app — the dev server's HMR WebSocket would keep every page out of the cache.
      name: 'bfcache',
      testMatch: BFCACHE_SPEC,
      use: {
        baseURL: PREVIEW_URL,
        channel: 'chromium',
        viewport: {width: 1280, height: 800},
        launchOptions: {ignoreDefaultArgs: ['--disable-back-forward-cache']},
      },
    },
    {
      // Service worker, update prompt and offline shell, on the built app where the worker exists.
      name: 'pwa',
      testMatch: PWA_SPEC,
      use: {baseURL: PREVIEW_URL, viewport: {width: 1280, height: 800}},
    },

    // ---- Staging tier ---- real backend, real sign-in, no stubs. ----
    ...(STAGING_BASE_URL
      ? [
          {
            name: 'staging-landscape',
            testMatch: STAGING_SPEC,
            use: {
              baseURL: STAGING_BASE_URL,
              viewport: {width: 1280, height: 800},
            },
          },
          {
            name: 'staging-portrait',
            testMatch: STAGING_SPEC,
            use: {
              baseURL: STAGING_BASE_URL,
              viewport: {width: 800, height: 1280},
            },
          },
        ]
      : []),
  ],
  ...(SKIP_WEBSERVER
    ? {}
    : {
        // --strictPort as vite.config.ts has it: a taken port is an error, never a silent move to the next one.
        // The dev server is started only when a project uses it.
        webServer: [
          ...(ON_DEV
            ? [
                {
                  name: 'dev',
                  command: `npx vite --port ${DEV_PORT} --strictPort`,
                  url: DEV_URL,
                  reuseExistingServer: false,
                },
              ]
            : []),
          {
            name: 'preview',
            command: `npm run build && npx vite preview --port ${PREVIEW_PORT} --strictPort`,
            url: PREVIEW_URL,
            reuseExistingServer: false,
          },
        ],
      }),
});
