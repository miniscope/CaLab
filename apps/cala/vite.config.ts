import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineCalabApp } from '@calab/vite-config';

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/** The commit being built: GitHub's sha on CI, else `git rev-parse HEAD`, else empty. */
const commit = process.env.GITHUB_SHA || git('rev-parse HEAD');
/** Uncommitted changes in the tree being built (never on CI's clean checkout). */
const dirty = !process.env.GITHUB_SHA && git('status --porcelain').length > 0;
/** The WASM engine's version: the `calab-cala` crate's package version. */
const engine =
  /^version\s*=\s*"([^"]+)"/m.exec(
    readFileSync(resolve(import.meta.dirname, '../../crates/cala/Cargo.toml'), 'utf8'),
  )?.[1] ?? '';

export default defineCalabApp(import.meta.dirname, {
  wasm: true,
  vite: {
    define: {
      __CALA_COMMIT__: JSON.stringify(commit),
      __CALA_GIT_DIRTY__: JSON.stringify(dirty),
      __CALA_ENGINE_VERSION__: JSON.stringify(engine),
    },
  },
});
