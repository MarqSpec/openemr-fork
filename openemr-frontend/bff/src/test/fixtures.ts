import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Secret, type Config} from '../config.js';

/** Synthetic OpenEMR host; `.test` never resolves, and MSW answers every call to it. */
export const OPENEMR_BASE_URL = 'https://openemr.example.test';
export const SMART_DISCOVERY_URL = `${OPENEMR_BASE_URL}/apis/default/fhir/.well-known/smart-configuration`;
export const FHIR_BASE_URL = `${OPENEMR_BASE_URL}/apis/default/fhir`;
export const OPENID_DISCOVERY_URL = `${OPENEMR_BASE_URL}/oauth2/default/.well-known/openid-configuration`;
/** Where the token handler serves the SPA and /bff/* — a different site from OpenEMR, as on staging. */
export const PUBLIC_ORIGIN = 'https://frontend.example.test';
export const CLIENT_ID = 'synthetic-client-id-7d2e';
/** Synthetic, and a sentinel: it must never appear in a response, a redirect or a log line. */
export const CLIENT_SECRET = 'SYNTHETIC-CLIENT-SECRET-SENTINEL-4b9a';
export const INDEX_HTML =
  '<!doctype html><html><head><title>OpenEMR</title></head><body><div id="root"></div></body></html>';
export const ASSET_PATH = '/assets/index-3f9a1c2b.js';
/** The PWA files Vite copies from `public/` unhashed (FR-PWA-1). */
export const MANIFEST_PATH = '/manifest.webmanifest';
export const MANIFEST_JSON = JSON.stringify({
  name: 'Synthetic PWA',
  start_url: '/',
  display: 'standalone',
});
export const ICON_PATH = '/icons/icon-192.png';
/** The eight-byte PNG signature: enough for a content-type test, not a picture. */
export const ICON_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** A build file outside `assets/`, so not fingerprinted, with a content type Railway's CDN treats as static. */
export const UNHASHED_STATIC_PATH = '/favicon.svg';

/** Content that must never be served: beside the build folder, and a dotfile inside it. */
export const OUTSIDE_SENTINEL = 'SYNTHETIC-SENTINEL-OUTSIDE-THE-BUILD';
export const SIBLING_SENTINEL = 'SYNTHETIC-SENTINEL-IN-A-PREFIX-SIBLING';
export const DOTFILE_SENTINEL = 'SYNTHETIC-SENTINEL-IN-A-DOTFILE';

/**
 * A throwaway `vite build` output at `<root>/dist`, with `<root>/secret.txt` and `<root>/distsecret.txt`
 * beside it (a traversal target, and a sibling sharing the folder's name as a prefix) and `dist/.env` inside.
 */
export async function makeSpaDist(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'bff-dist-'));
  const dir = path.join(root, 'dist');
  await mkdir(path.join(dir, 'assets'), {recursive: true});
  await writeFile(path.join(dir, 'index.html'), INDEX_HTML);
  await writeFile(path.join(dir, ASSET_PATH), 'console.log("app");');
  await mkdir(path.join(dir, 'icons'));
  await writeFile(path.join(dir, MANIFEST_PATH), MANIFEST_JSON);
  await writeFile(path.join(dir, ICON_PATH), ICON_BYTES);
  await writeFile(
    path.join(dir, UNHASHED_STATIC_PATH),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  await writeFile(path.join(dir, '.env'), DOTFILE_SENTINEL);
  await writeFile(path.join(root, 'secret.txt'), OUTSIDE_SENTINEL);
  await writeFile(path.join(root, 'distsecret.txt'), SIBLING_SENTINEL);
  return {dir, cleanup: () => rm(root, {recursive: true, force: true})};
}

export function testConfig(
  spaDistDir: string,
  overrides: Partial<Config> = {},
): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    spaDistDir,
    smartDiscoveryUrl: SMART_DISCOVERY_URL,
    openidDiscoveryUrl: OPENID_DISCOVERY_URL,
    authorizeOrigin: OPENEMR_BASE_URL,
    publicOrigin: PUBLIC_ORIGIN,
    cookieMode: 'host-prefixed',
    oauth: {
      clientId: CLIENT_ID,
      clientSecret: new Secret(CLIENT_SECRET),
      timeoutMs: 1000,
    },
    readyTimeoutMs: 1000,
    fhirProxy: {
      baseUrl: FHIR_BASE_URL,
      timeoutMs: 1000,
      maxConcurrent: 4,
      maxConcurrentPerSession: 3,
    },
    logLevel: 'silent',
    session: {idleTimeoutMs: 15 * 60 * 1000, maxSessionMs: 10 * 60 * 60 * 1000},
    build: 'unknown',
    ...overrides,
  };
}

/** The minimum a SMART configuration document must carry (SMART App Launch 2.x §2.1). */
export const SMART_CONFIGURATION = {
  issuer: `${OPENEMR_BASE_URL}/oauth2/default`,
  authorization_endpoint: `${OPENEMR_BASE_URL}/oauth2/default/authorize`,
  token_endpoint: `${OPENEMR_BASE_URL}/oauth2/default/token`,
  code_challenge_methods_supported: ['S256'],
  capabilities: ['sso-openid-connect', 'permission-offline'],
};
