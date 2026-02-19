import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'dist/',
      'apps/*/dist/',
      'packages/*/dist/',
      'wasm/',
      '.planning/',
      '*.config.js',
      '*.config.ts',
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended (non-type-checked for speed)
  ...tseslint.configs.recommended,

  // SolidJS rules for app TS/TSX files
  {
    files: ['apps/catune/src/**/*.{ts,tsx}'],
    ...solid,
  },

  // Browser globals for app src/
  {
    files: ['apps/catune/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Worker globals for app workers/
  {
    files: ['apps/catune/src/workers/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.worker,
      },
    },
  },

  // Import boundary: only packages/core/src/wasm-adapter.ts may import from the WASM pkg
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'],
    ignores: ['packages/core/src/wasm-adapter.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/wasm/catune-solver/pkg/*'],
              message: 'Import from @catune/core instead of the WASM pkg directly.',
            },
          ],
        },
      ],
    },
  },

  // Import boundary: only packages/community/src/supabase.ts may import @supabase/supabase-js
  // (community-store uses type imports for User/Session — allowed since it's in the community boundary)
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'],
    ignores: [
      'packages/community/src/supabase.ts',
      'apps/catune/src/lib/community/community-store.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@supabase/supabase-js'],
              message: 'Import from @catune/community instead of @supabase/supabase-js directly.',
            },
          ],
        },
      ],
    },
  },

  // Import boundary: no deep imports into package internals — use barrels only
  {
    files: ['apps/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@catune/*/src/*'],
              message:
                'Import from the package barrel (@catune/<pkg>) instead of reaching into src/.',
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
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // SolidJS-specific rule overrides (scoped to app files where solid plugin is loaded)
  {
    files: ['apps/catune/src/**/*.{ts,tsx}'],
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
