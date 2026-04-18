import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    passWithNoTests: false,
    // Keep E2E opt-in: the Phase 5 exit spec lives under `e2e/` and
    // reads real AVI bytes from `.test_data/`, which is not in CI's
    // checkout. Run explicitly via `npm run test:e2e -w apps/cala`
    // (or `npm run test:e2e:cala` from the repo root).
    exclude: ['**/node_modules/**', 'e2e/**'],
    environmentMatchGlobs: [['src/lib/__tests__/**', 'node']],
  },
});
