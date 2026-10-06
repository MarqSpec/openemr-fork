// Google TypeScript Style (gts) is the base; typescript-eslint strict-type-checked sits on top — the SPA's
// rules minus React. reference: CONVENTIONS.md (Enforcement)
import {defineConfig} from 'eslint/config';
import globals from 'globals';
import gts from 'gts/build/src/index.js';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {ignores: ['dist/', 'coverage/', '.npm/', 'node_modules/']},
  ...gts,
  {
    files: ['**/*.ts'],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: globals.node,
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
      ],
    },
  },
  {
    // Tool configs must default-export by contract.
    files: ['vitest.config.ts'],
    rules: {'no-restricted-exports': 'off'},
  },
  {
    // Not published to npm, and TypeScript resolves the `.js` specifiers NodeNext requires.
    rules: {
      'n/no-unpublished-import': 'off',
      'n/no-missing-import': 'off',
    },
  },
]);
