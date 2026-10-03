import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests for the combined static site (see e2e/README.md).
 *
 * The suite runs against the production build, not the dev server:
 * `npm run build:e2e` produces dist/CaLab/ with the GitHub Pages base path,
 * and e2e/serve.mjs serves dist/ so the site lives at /CaLab/ as it does on
 * Pages. `npm run test:e2e` does not rebuild; run build:e2e first.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  // The WASM solver runs real work in these tests; keep generous headroom on
  // shared CI runners without letting a hung run sit for the default 30 s x N.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}/CaLab/`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node e2e/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/CaLab/`,
    reuseExistingServer: !isCI,
    timeout: 10_000,
  },
});
