import path from 'node:path';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@calab/core': path.resolve(repoRoot, 'packages/core/src'),
      '@calab/io': path.resolve(repoRoot, 'packages/io/src'),
      '@calab/tutorials': path.resolve(repoRoot, 'packages/tutorials/src'),
      '@calab/ui': path.resolve(repoRoot, 'packages/ui/src'),
    },
  },
  envDir: repoRoot,
  base: process.env.GITHUB_ACTIONS ? '/CaLab/CaRank/' : process.env.CALAB_PAGES ? '/CaRank/' : '/',
  plugins: [solidPlugin()],
  build: {
    target: 'esnext',
  },
});
