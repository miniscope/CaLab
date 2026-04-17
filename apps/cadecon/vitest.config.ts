import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: {
    alias: {
      '@calab/core': path.resolve(repoRoot, 'packages/core/src'),
      '@calab/compute': path.resolve(repoRoot, 'packages/compute/src'),
      '@calab/io': path.resolve(repoRoot, 'packages/io/src'),
      '@calab/community': path.resolve(repoRoot, 'packages/community/src'),
      '@calab/tutorials': path.resolve(repoRoot, 'packages/tutorials/src'),
      '@calab/ui': path.resolve(repoRoot, 'packages/ui/src'),
    },
  },
  test: {
    passWithNoTests: false,
    environmentMatchGlobs: [['src/lib/__tests__/**', 'node']],
  },
});
