import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';

// Every app and package source tree. Globbed rather than listed so a new app or
// package gets the Solid rules and browser globals without editing this file.
const SOURCE_FILES = ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'dist/',
      'apps/*/dist/',
      'packages/*/dist/',
      'crates/',
      '.planning/',
      '*.config.js',
      '*.config.ts',
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended (non-type-checked for speed)
  ...tseslint.configs.recommended,

  // SolidJS rules for every app and package
  {
    files: SOURCE_FILES,
    ...solid,
  },

  // Browser globals for every app and package
  {
    files: SOURCE_FILES,
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Worker globals for app workers/
  {
    files: ['apps/*/src/workers/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.worker,
      },
    },
  },

  // Node globals for build scripts
  {
    files: ['scripts/**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Import boundaries (merged into one block so flat-config doesn't silently override)
  // (community-store uses type imports for User/Session — allowed since it's in the community boundary)
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: [
      'packages/core/src/wasm-adapter.ts',
      'packages/community/src/supabase.ts',
      'packages/community/src/auth.ts',
      'packages/community/src/submission-service.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/crates/solver/pkg/*'],
              message: 'Import from @calab/core instead of the WASM pkg directly.',
            },
            {
              group: ['@supabase/supabase-js'],
              message: 'Import from @calab/community instead of @supabase/supabase-js directly.',
            },
            {
              group: ['@calab/*/src/*'],
              message:
                'Import from the package barrel (@calab/<pkg>) instead of reaching into src/.',
            },
          ],
        },
      ],
    },
  },

  // Pragmatic rule overrides
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // SolidJS-specific rule overrides (scoped to files where solid plugin is loaded)
  {
    files: SOURCE_FILES,
    rules: {
      // .map() is fine for small static arrays; <For> migration is incremental
      'solid/prefer-for': 'off',
      // String style props work and are more concise for simple cases
      'solid/style-prop': 'off',
      // Early returns in components are sometimes intentional (loading guards)
      'solid/components-return-once': 'warn',
    },
  },
);
