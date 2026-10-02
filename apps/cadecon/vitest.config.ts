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
    // Vitest 4 removed environmentMatchGlobs (it was a silent no-op here), so
    // state the environment vite-plugin-solid was already defaulting to. Tests
    // that need plain Node opt in with a `// @vitest-environment node` docblock.
    environment: 'jsdom',
  },
});
