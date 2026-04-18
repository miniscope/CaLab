/**
 * Separate vitest config for the Phase 5 exit E2E. Kept opt-in (not
 * picked up by the default `npm test` / `vitest run`) because the spec
 * reads a real AVI from `.test_data/` which is a local-only, gitignored
 * directory. CI and a clean checkout wouldn't have it, and the unit
 * suite should not require it.
 *
 * Run explicitly via:
 *     npm run test:e2e -w apps/cala
 *     npm run test:e2e:cala      # from repo root
 */

import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    // E2E reads a real AVI byte stream and pumps it through all four
    // workers — default 5s per-test timeout is too tight once the
    // fixture grows. The spec itself also sets a per-test timeout.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
  },
});
