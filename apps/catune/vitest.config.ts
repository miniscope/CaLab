import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    passWithNoTests: false,
    // Vitest 4 removed environmentMatchGlobs (it was a silent no-op here), so
    // state the environment vite-plugin-solid was already defaulting to. Tests
    // that need plain Node opt in with a `// @vitest-environment node` docblock.
    environment: 'jsdom',
  },
});
