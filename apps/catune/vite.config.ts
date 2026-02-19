import path from 'node:path';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
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
  envDir: repoRoot,
  base: process.env.GITHUB_ACTIONS ? '/CaLab/CaTune/' : process.env.CALAB_PAGES ? '/CaTune/' : '/',
  plugins: [solidPlugin(), wasm()],
  worker: {
    plugins: () => [wasm()],
    format: 'es',
  },
  build: {
    target: 'esnext',
  },
});
