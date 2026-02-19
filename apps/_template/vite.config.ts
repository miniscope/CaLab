import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const repoRoot = path.resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const displayName = pkg.calab?.displayName ?? path.basename(__dirname);

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
  base: process.env.GITHUB_ACTIONS
    ? `/CaLab/${displayName}/`
    : process.env.CALAB_PAGES
      ? `/${displayName}/`
      : '/',
  plugins: [solidPlugin()],
  build: {
    target: 'esnext',
  },
});
