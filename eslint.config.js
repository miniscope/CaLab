import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['dist/', 'wasm/', '.planning/', '*.config.js', '*.config.ts'],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended (non-type-checked for speed)
  ...tseslint.configs.recommended,

  // SolidJS rules for all TS/TSX files
  {
    files: ['src/**/*.{ts,tsx}'],
    ...solid,
  },

  // Browser globals for src/
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Worker globals for src/workers/
  {
    files: ['src/workers/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.worker,
      },
    },
  },

  // Import boundary: only wasm-adapter.ts may import from the WASM pkg
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/wasm-adapter.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/wasm/catune-solver/pkg/*'],
              message: 'Import from lib/wasm-adapter.ts instead of the WASM pkg directly.',
            },
          ],
        },
      ],
    },
  },

  // Import boundary: only lib/supabase.ts and lib/community/ import @supabase/supabase-js
  // (community-store uses type imports for User/Session)
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/supabase.ts', 'src/lib/community/**'],
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
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/community/**',
      'src/components/community/**',
      'src/App.tsx',
      'src/components/layout/**',
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
      // .map() is fine for small static arrays; <For> migration is incremental
      'solid/prefer-for': 'off',
      // String style props work and are more concise for simple cases
      'solid/style-prop': 'off',
      // Early returns in components are sometimes intentional (loading guards)
      'solid/components-return-once': 'warn',
    },
  },
);
