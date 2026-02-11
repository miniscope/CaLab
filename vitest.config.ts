import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    passWithNoTests: true,
    environmentMatchGlobs: [
      ['src/lib/__tests__/**', 'node'],
    ],
  },
});
