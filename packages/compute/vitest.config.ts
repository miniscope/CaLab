import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@catune/core': path.resolve(__dirname, '../core/src'),
      '@catune/compute': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
