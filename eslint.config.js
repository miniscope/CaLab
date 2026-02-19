import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['dist/', 'apps/*/dist/', 'packages/*/dist/', 'wasm/', '.planning/', '*.config.js', '*.config.ts'],
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

  // Import boundary: only lib/supabase.ts and lib/community/ import @supabase/supabase-js
  // (community-store uses type imports for User/Session)
  {
    files: ['apps/catune/src/**/*.{ts,tsx}'],
    ignores: ['apps/catune/src/lib/supabase.ts', 'apps/catune/src/lib/community/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@supabase/supabase-js'],
              message: 'Import from lib/supabase.ts instead of @supabase/supabase-js directly.',
            },
          ],
        },
      ],
    },
  },

  // Import boundary: only lib/community/ and top-level layout use lib/supabase.ts
  // (supabaseEnabled flag is read by App.tsx and layout components for conditional rendering)
  {
    files: ['apps/catune/src/**/*.{ts,tsx}'],
    ignores: [
      'apps/catune/src/lib/community/**',
      'apps/catune/src/components/community/**',
      'apps/catune/src/App.tsx',
      'apps/catune/src/components/layout/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/lib/supabase', '**/lib/supabase.ts'],
              message: 'Only community module and layout files should import from lib/supabase.ts.',
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
