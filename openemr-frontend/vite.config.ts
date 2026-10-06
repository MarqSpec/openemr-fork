import react from '@vitejs/plugin-react';
import {loadEnv} from 'vite';
import {defineConfig} from 'vitest/config';

import pkg from './package.json';
import {precacheServiceWorker} from './src/pwa/precache_plugin';

// The commit the build is from, when its environment says (Railway, GitHub Actions, or set by hand).
// Only these names are read, so no other environment variable can reach the bundle. reference: FR-UI-3, a separate change
const COMMIT_VARIABLES = [
  'APP_COMMIT_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
  'GITHUB_SHA',
];

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', COMMIT_VARIABLES);
  const commit =
    COMMIT_VARIABLES.map(name => env[name] ?? '').find(value =>
      /^[0-9a-f]{7,40}$/i.test(value),
    ) ?? '';
  return {
    // The service worker is built only for production: the dev server and Vitest never register one.
    plugins: [
      react(),
      precacheServiceWorker({entry: 'src/pwa/service_worker.ts'}),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_COMMIT__: JSON.stringify(commit),
    },
    server: {
      port: 5173,
      strictPort: true,
      // The registered local origin is this dev server (config/oauth-clients.json), so /bff/* is proxied to the
      // token handler and the browser stays on :5173. Host and Origin pass through unchanged (FR-BFF-6).
      // bff/README.md (Local development)
      proxy: {'/bff': {target: 'http://localhost:8080', changeOrigin: false}},
    },
    test: {
      restoreMocks: true,
      projects: [
        {
          extends: true,
          test: {
            name: 'spa',
            environment: 'jsdom',
            globals: true,
            setupFiles: ['./src/test/setup.ts'],
            include: ['src/**/*.test.{ts,tsx}'],
          },
        },
        {
          // Operator tooling: Node, no DOM, no SPA setup file.
          extends: true,
          test: {
            name: 'scripts',
            environment: 'node',
            include: ['scripts/**/*.test.ts'],
          },
        },
      ],
    },
  };
});
