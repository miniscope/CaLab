import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@calab/core': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
