// @vitest-environment node
import {fileURLToPath} from 'node:url';

import {ESLint, Linter} from 'eslint';
import {beforeAll, describe, expect, it} from 'vitest';

// reference: REQUIREMENTS.md NFR-CON-2 · CONVENTIONS.md (only src/api/ may touch the network)
// Resolves the repo's own eslint.config.mjs for a file outside and a file inside src/api/, then lints fixture
// strings with the network rules it resolved (no type-aware parse, so the test stays fast).

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUTSIDE = 'src/app/App.tsx';
const INSIDE = 'src/api/fhir/transport.ts';
const NETWORK_RULES = new Set([
  'no-restricted-globals',
  'no-restricted-properties',
]);

const VARIANTS = [
  "void fetch('/x');",
  "void window.fetch('/x');",
  "void globalThis.fetch('/x');",
  "void self.fetch('/x');",
  "void window['fetch']('/x');",
  'const {fetch: f} = window;\nvoid f;',
  'void new XMLHttpRequest();',
  'void new window.XMLHttpRequest();',
  'void new globalThis.XMLHttpRequest();',
  'void new self.XMLHttpRequest();',
  "void new WebSocket('wss://x');",
  "void new window.WebSocket('wss://x');",
  "void new globalThis.WebSocket('wss://x');",
  "void new self.WebSocket('wss://x');",
  "void new EventSource('/x');",
  "void new window.EventSource('/x');",
  "void new globalThis.EventSource('/x');",
  "void new self.EventSource('/x');",
  "void navigator.sendBeacon('/x');",
  "void window.navigator.sendBeacon('/x');",
];

const eslint = new ESLint({cwd: ROOT});
const linter = new Linter();

async function networkErrors(code: string, filePath: string) {
  const resolved = (await eslint.calculateConfigForFile(filePath)) as {
    rules?: Linter.RulesRecord;
  };
  const rules = Object.fromEntries(
    Object.entries(resolved.rules ?? {}).filter(([id]) =>
      NETWORK_RULES.has(id),
    ),
  );
  return linter
    .verify(code, {languageOptions: {sourceType: 'module'}, rules})
    .filter(m => m.ruleId !== null && NETWORK_RULES.has(m.ruleId));
}

describe('given the network boundary lint rule (NFR-CON-2)', () => {
  // Loading the config (gts, typescript-eslint) is slow once; every lint after it is fast.
  beforeAll(async () => {
    await eslint.calculateConfigForFile(OUTSIDE);
  }, 120_000);

  it.each(VARIANTS)(
    'when `%s` is written outside src/api/, then lint rejects it',
    async code => {
      expect(await networkErrors(code, OUTSIDE)).not.toHaveLength(0);
    },
  );

  it.each(VARIANTS)(
    'when `%s` is written inside src/api/, then lint allows it',
    async code => {
      expect(await networkErrors(code, INSIDE)).toHaveLength(0);
    },
  );
});

// the service worker's entry is the one file outside src/api/ that may fetch: it serves the app
// shell and never reads /bff (src/pwa/precache.ts routes those past it). Its neighbours stay fenced.
describe('given the service worker (FR-PWA-2)', () => {
  const WORKER_ENTRY = 'src/pwa/service_worker.ts';
  const WORKER_LOGIC = 'src/pwa/worker.ts';

  it.each(VARIANTS.filter(code => code.includes('fetch')))(
    'when its entry fetches as `%s`, then lint allows it',
    async code => {
      expect(await networkErrors(code, WORKER_ENTRY)).toHaveLength(0);
    },
  );

  // the exemption is fetch alone. The worker needs nothing else, so a socket, a stream, an XHR or a beacon in
  // its entry is as much a boundary breach as anywhere else.
  it.each(VARIANTS.filter(code => !code.includes('fetch')))(
    'when `%s` is written in its entry, then lint still rejects it (guards the fetch exemption widening to every network API)',
    async code => {
      expect(await networkErrors(code, WORKER_ENTRY)).not.toHaveLength(0);
    },
  );

  it.each(VARIANTS)(
    'when `%s` is written in the worker logic beside it, then lint still rejects it (guards a widening exemption)',
    async code => {
      expect(await networkErrors(code, WORKER_LOGIC)).not.toHaveLength(0);
    },
  );
});
