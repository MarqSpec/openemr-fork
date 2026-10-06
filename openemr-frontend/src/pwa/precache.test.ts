// @vitest-environment node
import {describe, expect, it} from 'vitest';

import {isBffPath, precacheUrls, routeFor} from './precache';

// reference: REQUIREMENTS.md FR-PWA-2, FR-PWA-4, NFR-SEC-1

const ORIGIN = 'https://dashboard.example.test';
const PRECACHED: ReadonlySet<string> = new Set([
  '/index.html',
  '/assets/index-Bq1x2y3z.js',
  '/assets/index-C4d5e6f7.css',
]);

function get(path: string, mode: RequestMode = 'cors') {
  return {method: 'GET', url: `${ORIGIN}${path}`, mode};
}

describe('given the files a production build writes', () => {
  const BUILD = [
    'index.html',
    'assets/index-Bq1x2y3z.js',
    'assets/index-C4d5e6f7.css',
    'assets/lato-latin-400-D8e9f0a1.woff2',
    'sw.js',
    'manifest.webmanifest',
    'icons/icon-192.png',
    'assets/index-Bq1x2y3z.js.map',
    'stats.html',
  ];

  it('when the precache list is built, then it holds the page and the fingerprinted assets only, as root paths, sorted', () => {
    expect(precacheUrls(BUILD)).toEqual([
      '/assets/index-Bq1x2y3z.js',
      '/assets/index-C4d5e6f7.css',
      '/assets/lato-latin-400-D8e9f0a1.woff2',
      '/index.html',
    ]);
  });

  it('when the precache list is built, then the service worker never precaches itself, a source map, the manifest or an icon (guards precaching more than the shell)', () => {
    const urls = precacheUrls(BUILD);
    expect(urls).not.toContain('/sw.js');
    expect(urls.some(url => url.endsWith('.map'))).toBe(false);
    expect(urls).not.toContain('/manifest.webmanifest');
    expect(urls.some(url => url.startsWith('/icons/'))).toBe(false);
  });

  it('when a build has no index.html, then the list cannot be built (guards a shell that cannot open offline)', () => {
    expect(() => precacheUrls(['assets/index-Bq1x2y3z.js'])).toThrow(
      /index\.html/,
    );
  });
});

describe('given the token handler namespace', () => {
  it.each([
    '/bff',
    '/bff/',
    '/bff/session',
    '/bff/fhir/Patient/1',
    '/BFF/session',
    '/bff%2fsession',
    '/%62ff/session',
    '//bff/session',
    '/bff;x/y',
    '/bff%5csession',
  ])('when the path is %s, then it is a /bff path', path => {
    expect(isBffPath(path)).toBe(true);
  });

  // a bad percent-escape cannot be decoded, so the token handler judges the raw path (bff/src/server.ts).
  it.each([
    '/bff/%zz/fhir',
    '/BFF/%zz',
    '//bff/%E0%A4%A',
    '/bff\\%zz',
    '/bff;%zz',
  ])(
    'when the path is %s, with a bad percent-escape, then it is still a /bff path, judged raw as the token handler judges it (guards the worker answering a /bff path it cannot decode)',
    path => {
      expect(isBffPath(path)).toBe(true);
    },
  );

  it.each(['/', '/signed-out', '/bffx', '/assets/bff.js', '/%zz', '/bff%zz'])(
    'when the path is %s, then it is not a /bff path',
    path => {
      expect(isBffPath(path)).toBe(false);
    },
  );
});

describe('given a request reaching the service worker', () => {
  it('when it is any /bff read, then it goes to the network untouched — never the cache (guards PHI in Cache Storage)', () => {
    expect(routeFor(get('/bff/session'), ORIGIN, PRECACHED)).toBe('network');
    expect(routeFor(get('/bff/fhir/Patient/1'), ORIGIN, PRECACHED)).toBe(
      'network',
    );
  });

  it('when it is a /bff navigation such as the sign-in callback, then it goes to the network untouched (guards the offline shell answering OAuth)', () => {
    expect(
      routeFor(
        get('/bff/callback?code=x&state=y', 'navigate'),
        ORIGIN,
        PRECACHED,
      ),
    ).toBe('network');
  });

  it('when it is a /bff navigation with a bad percent-escape, then it goes to the network untouched — never the offline shell (guards the worker answering what the token handler would 404)', () => {
    expect(routeFor(get('/bff/%zz/fhir', 'navigate'), ORIGIN, PRECACHED)).toBe(
      'network',
    );
    expect(routeFor(get('/bff/%zz/fhir'), ORIGIN, PRECACHED)).toBe('network');
  });

  it('when it is the sign-out form post, then it goes to the network untouched (guards the service worker swallowing a POST)', () => {
    expect(
      routeFor(
        {method: 'POST', url: `${ORIGIN}/bff/logout`, mode: 'navigate'},
        ORIGIN,
        PRECACHED,
      ),
    ).toBe('network');
  });

  it('when it asks for a precached asset, then the precache answers it', () => {
    expect(routeFor(get('/assets/index-Bq1x2y3z.js'), ORIGIN, PRECACHED)).toBe(
      'precache',
    );
  });

  it('when a precached path carries a query string, then it goes to the network (guards serving a different resource from the cache)', () => {
    expect(
      routeFor(get('/assets/index-Bq1x2y3z.js?v=2'), ORIGIN, PRECACHED),
    ).toBe('network');
  });

  it('when it asks for a file outside the precache (manifest, icon, another build), then it goes to the network and is not stored', () => {
    expect(routeFor(get('/manifest.webmanifest'), ORIGIN, PRECACHED)).toBe(
      'network',
    );
    expect(routeFor(get('/assets/index-OLDHASH.js'), ORIGIN, PRECACHED)).toBe(
      'network',
    );
  });

  it('when it is a page navigation, then it is the shell route: the network first, the precached page only when offline', () => {
    expect(routeFor(get('/', 'navigate'), ORIGIN, PRECACHED)).toBe('shell');
    expect(routeFor(get('/signed-out', 'navigate'), ORIGIN, PRECACHED)).toBe(
      'shell',
    );
    expect(routeFor(get('/index.html', 'navigate'), ORIGIN, PRECACHED)).toBe(
      'shell',
    );
  });

  it('when it is for another origin, then it goes to the network untouched', () => {
    expect(
      routeFor(
        {
          method: 'GET',
          url: 'https://openemr.example.test/assets/index-Bq1x2y3z.js',
          mode: 'cors',
        },
        ORIGIN,
        PRECACHED,
      ),
    ).toBe('network');
  });
});
