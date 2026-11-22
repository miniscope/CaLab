import { execSync } from 'node:child_process';
import { defineCalabApp } from '@calab/vite-config';

/** The commit being built: GitHub's sha on CI, else `git rev-parse HEAD`, else empty. */
function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

export default defineCalabApp(import.meta.dirname, {
  wasm: true,
  vite: { define: { __CALA_COMMIT__: JSON.stringify(commit()) } },
});
