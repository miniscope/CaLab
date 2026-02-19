import path from 'node:path';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@catune/core': path.resolve(repoRoot, 'packages/core/src'),
      '@catune/io': path.resolve(repoRoot, 'packages/io/src'),
      '@catune/ui': path.resolve(repoRoot, 'packages/ui/src'),
    },
  },
  envDir: repoRoot,
  base: process.env.GITHUB_ACTIONS ? '/CaLab/carank/' : '/',
  plugins: [solidPlugin()],
  build: {
    target: 'esnext',
  },
});
