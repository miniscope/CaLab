import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  // Component tests (*.test.tsx) render with Solid's browser build in jsdom.
  plugins: [solidPlugin()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
