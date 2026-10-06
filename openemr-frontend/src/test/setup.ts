import '@testing-library/jest-dom/vitest';
import {cleanup, configure} from '@testing-library/react';
import {afterAll, afterEach, beforeAll, expect} from 'vitest';

import {server} from './msw_server';
import {ASYNC_UTIL_TIMEOUT} from './timeouts';
import {warmUp} from './warm_up';

// A wait outlasts a loaded runner's stretch and still gives up before its spec does.
configure({asyncUtilTimeout: ASYNC_UTIL_TIMEOUT});

// No real network: a request no handler answers fails the test.
beforeAll(() => {
  server.listen({onUnhandledRequest: 'error'});
});

// A component spec's file pays its cold start here, not inside its first spec.
beforeAll(() => {
  if (expect.getState().testPath?.endsWith('.tsx') !== true) return;
  warmUp();
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute('data-theme');
  }
});

afterAll(() => {
  server.close();
});

// jsdom has no matchMedia; report a light-preferring device unless a test overrides it. (A test that opts into
// the node environment has no window at all.)
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
