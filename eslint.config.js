import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default ts.config(
  // Global ignores
  {
    ignores: ['**/dist/', '**/build/', '**/.svelte-kit/', '**/node_modules/'],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules (type-aware disabled — too slow for pre-commit)
  ...ts.configs.recommended,

  // Svelte recommended rules
  ...svelte.configs['flat/recommended'],

  // ── Shared settings ──────────────────────────────────────────────────────────

  {
    rules: {
      // Strict but reasonable — warn on these so they don't block during early dev,
      // but they're visible and should be cleaned up.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',

      // Allow console in a dev tool project
      'no-console': 'off',
    },
  },

  // ── Svelte files ─────────────────────────────────────────────────────────────

  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        parser: ts.parser,
      },
    },
    rules: {
      // Svelte 5 runes are module-level side effects — this rule doesn't understand them
      'svelte/no-unused-svelte-ignore': 'warn',

      // $state, $derived, etc. look like unused vars to the TS rule
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^(_|\\$)',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // $effect blocks often read reactive deps as bare expressions to track them
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-unused-expressions': 'off',
    },
  },

  // ── Client (browser) ────────────────────────────────────────────────────────

  {
    files: ['client/src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // ── Server (Node.js) ────────────────────────────────────────────────────────

  {
    files: ['server/src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ── Shared (both environments) ───────────────────────────────────────────────

  {
    files: ['shared/src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },

  // ── Test files — relax some rules ────────────────────────────────────────────

  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ── Node.js scripts / config ───────────────────────────────────────────────

  {
    files: ['bin/**/*.js', '*.config.js', '*.config.ts', 'client/*.config.*', 'server/*.config.*'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
