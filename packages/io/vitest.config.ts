import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';
import path from 'node:path';

export default defineConfig({
  // vite-plugin-solid resolves solid-js to its browser build so the reactive
  // import store (import-store.ts) behaves in tests as it does in the apps;
  // the Node "server" build has no reactivity.
  plugins: [solidPlugin()],
  resolve: {
    alias: {
      '@calab/core': path.resolve(__dirname, '../core/src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
