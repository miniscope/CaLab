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
      // Per-package floors, set a point or two under the numbers measured when
      // coverage was introduced (Oct 2026) so a regression fails CI. Raise
      // them as tests are added. Apps and packages/tutorials (no tests yet)
      // are reported but not gated.
      thresholds: {
        'packages/core/src/**': { lines: 96, statements: 96, functions: 90, branches: 92 },
        'packages/io/src/**': { lines: 75, statements: 74, functions: 58, branches: 68 },
        'packages/compute/src/**': { lines: 66, statements: 64, functions: 69, branches: 58 },
        'packages/community/src/**': { lines: 41, statements: 36, functions: 42, branches: 20 },
        'packages/ui/src/**': { lines: 4, statements: 4, functions: 2, branches: 6 },
      },
    },
  },
});
