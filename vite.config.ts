import path from 'node:path';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  base: process.env.GITHUB_ACTIONS ? '/CaTune/' : '/',
  plugins: [
    solidPlugin(),
    wasm(),
  ],
  worker: {
    plugins: () => [
      wasm(),
    ],
    format: 'es',
  },
  build: {
    target: 'esnext',
  },
});
