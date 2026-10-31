import { defineConfig } from '@playwright/test';

/**
 * Self-contained GPU suite for @calab/compute-gpu (the root Playwright config
 * runs only the combined-site e2e). Serves harness/ with Vite on :4177.
 *
 * Browser: Playwright's full Chromium (`channel: 'chromium'`, new headless
 * mode) exposes the real GPU adapter (Metal on macOS) with no extra flags.
 * The default chromium-headless-shell has no WebGPU adapter; set
 * GPU_SPIKE_SWIFTSHADER=1 to use it with the SwiftShader software adapter
 * instead (slow; for machines without a usable GPU).
 */
const PORT = 4177;
const swiftshader = Boolean(process.env.GPU_SPIKE_SWIFTSHADER);

export default defineConfig({
  testDir: 'gpu-tests',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 20 * 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    ...(swiftshader
      ? {
          launchOptions: {
            args: [
              '--use-angle=swiftshader',
              '--enable-unsafe-swiftshader',
              '--enable-unsafe-webgpu',
            ],
          },
        }
      : { channel: 'chromium' }),
  },
  webServer: {
    command: `npx vite harness --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
