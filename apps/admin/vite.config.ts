import path from 'node:path';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@calab/community': path.resolve(repoRoot, 'packages/community/src'),
      '@calab/ui': path.resolve(repoRoot, 'packages/ui/src'),
    },
  },
  envDir: repoRoot,
  base: process.env.GITHUB_ACTIONS ? '/CaLab/Admin/' : process.env.CALAB_PAGES ? '/Admin/' : '/',
  plugins: [solidPlugin()],
  build: {
    target: 'esnext',
  },
});
