import { defineConfig } from 'vitest/config';

// Root config used only by `npm run test:coverage`: runs every workspace's own
// vitest.config.ts as a project in one process so V8 coverage merges into a
// single report. `npm test` still runs each workspace separately.
export default defineConfig({
  test: {
    // Apps configure Vitest inside vite.config.ts via @calab/vite-config.
    projects: ['apps/*/vite.config.ts', 'packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.d.ts'],
      // Per-package floors, set a point or two under the measured numbers so
      // a regression fails CI. Raise them as tests are added. Apps and
      // packages/tutorials (no tests yet) are reported but not gated.
      // Re-measured Oct 2026 when the shared app code was hoisted (review
      // 2.1/2.8): io gained the tested import store and lost the CaTune
      // export (now in the app), compute lost the untested CaTune pool, core
      // lost the CaTune export schema, community-ui gained the tested
      // submission payload helpers, and ui gained the import flow with a
      // jsdom render test (import-flow.test.tsx).
      thresholds: {
        'packages/core/src/**': { lines: 98, statements: 97, functions: 98, branches: 93 },
        'packages/io/src/**': { lines: 87, statements: 86, functions: 78, branches: 80 },
        'packages/compute/src/**': { lines: 77, statements: 74, functions: 84, branches: 67 },
        'packages/community/src/**': { lines: 43, statements: 38, functions: 46, branches: 21 },
        'packages/ui/src/**': { lines: 25, statements: 27, functions: 36, branches: 14 },
        'packages/community-ui/src/**': { lines: 5, statements: 6, functions: 7, branches: 13 },
      },
    },
  },
});
