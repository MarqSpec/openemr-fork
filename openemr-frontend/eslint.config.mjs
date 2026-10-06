// Google TypeScript Style (gts) is the base; typescript-eslint strict-type-checked, React Hooks and
// jsx-a11y strict sit on top. reference: CONVENTIONS.md (Enforcement)
// .mjs, not .js: gts parses any eslint.config.js as CommonJS, and this package is ESM.
import {defineConfig} from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import gts from 'gts/build/src/index.js';
import tseslint from 'typescript-eslint';

const NETWORK_APIS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
const NETWORK_MESSAGE = 'Network access lives in src/api/ only (NFR-CON-2).';

const TYPOGRAPHY_COLOR =
  "JSXOpeningElement[name.name='Typography'] > JSXAttribute[name.name='color']";
const TYPOGRAPHY_COLORS =
  '/^(inherit|primary|success|error|info|warning|textPrimary|textSecondary)$/';
const TYPOGRAPHY_COLOR_MESSAGE =
  'Typography color takes a themed colour name (textSecondary, textPrimary, error, …); MUI 9.4 ignores a ' +
  'palette path such as "text.secondary".';

export default defineConfig([
  {
    ignores: [
      'dist/',
      'coverage/',
      '.npm/',
      'node_modules/',
      'documentation/',
      'test-results/',
      'playwright-report/',
      'blob-report/',
      // The token handler lints itself with its own config (bff/eslint.config.mjs).
      'bff/',
    ],
  },
  ...gts,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {tsconfigRootDir: import.meta.dirname},
    },
    rules: {
      // Google style: named exports only.
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
          },
        },
      ],
      // Google style: interfaces for object shapes.
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      // Google style: no `#private`; TypeScript visibility instead.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'PrivateIdentifier',
          message: 'Use TypeScript `private`, not #private.',
        },
        // MUI 9.4 Typography styles only its own colour names; a palette path ("text.secondary") or CSS
        // colour gets no rule and silently renders the inherited colour. Proven by typography_color_lint.test.ts.
        ...[
          `${TYPOGRAPHY_COLOR} Literal:not([value=${TYPOGRAPHY_COLORS}])`,
          `${TYPOGRAPHY_COLOR} TemplateLiteral`,
        ].map(selector => ({selector, message: TYPOGRAPHY_COLOR_MESSAGE})),
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    extends: [
      reactHooks.configs.flat['recommended-latest'],
      jsxA11y.flatConfigs.strict,
    ],
  },
  {
    // Operator tooling runs on Node, not in the browser, and has its own tsconfig.
    files: ['scripts/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {project: './scripts/tsconfig.json'},
    },
  },
  {
    // NFR-CON-2: every server read goes through the typed API layer, so only src/api/ may reach the network.
    // Globals catch the bare names; property-only entries catch them on any object (window., globalThis., self.,
    // navigator.), computed or destructured. Proven by src/api/network_boundary.test.ts.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/api/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...NETWORK_APIS.map(name => ({name, message: NETWORK_MESSAGE})),
      ],
      'no-restricted-properties': [
        'error',
        ...[...NETWORK_APIS, 'sendBeacon'].map(property => ({
          property,
          message: NETWORK_MESSAGE,
        })),
      ],
    },
  },
  {
    // the service worker's entry fetches the app shell for the offline fallback; it never answers /bff
    // (src/pwa/precache.ts). Only this file, and only `fetch`: XMLHttpRequest, WebSocket, EventSource and
    // sendBeacon stay fenced here too, and its logic (worker.ts) stays fenced entirely. Proven by
    // network_boundary.test.ts.
    files: ['src/pwa/service_worker.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...NETWORK_APIS.filter(name => name !== 'fetch').map(name => ({
          name,
          message: NETWORK_MESSAGE,
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...[...NETWORK_APIS, 'sendBeacon']
          .filter(property => property !== 'fetch')
          .map(property => ({property, message: NETWORK_MESSAGE})),
      ],
    },
  },
  {
    // Tool configs must default-export by contract.
    files: ['vite.config.ts', 'playwright.config.ts'],
    rules: {'no-restricted-exports': 'off'},
  },
  {
    // The SPA is bundled by Vite, not published to npm: eslint-plugin-n's Node module rules don't apply.
    rules: {
      'n/no-unpublished-import': 'off',
      'n/no-missing-import': 'off',
      'n/no-extraneous-import': 'off',
    },
  },
]);
