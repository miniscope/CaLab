/**
 * Shared Vite (and Vitest) config for every CaLab web app.
 *
 * An app's vite.config.ts is just:
 *
 *   import { defineCalabApp } from '@calab/vite-config';
 *   export default defineCalabApp(import.meta.dirname, { wasm: true });
 *
 * Everything an app used to repeat lives here: the GitHub Pages `base`, the
 * Solid plugin, the WASM/worker plugins, the test environment, `envDir`, and
 * the `__APP_ID__` define. App identity comes from the app's package.json
 * `calab` block, so adding an app means creating the folder and setting
 * `calab.id`; nothing else in the repo has to list it.
 *
 * There are no `resolve.alias` entries: every `@calab/*` package points
 * `main`/`exports` at its TypeScript source, so Vite (and tsc) resolve the
 * workspace symlinks directly.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';

/**
 * Valid `calab.id` slugs. Keep in sync with the analytics_sessions.app_name
 * CHECK (supabase/migrations/015_*) and the geo-session edge function.
 */
export const APP_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

/** Fallback when not on GitHub Actions (GITHUB_REPOSITORY unset). */
const DEFAULT_PAGES_REPO = 'CaLab';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

export interface CalabAppOptions {
  /**
   * The app loads the Rust/WASM solver (directly or from a worker): add
   * vite-plugin-wasm to the main and worker builds and emit ES-module workers.
   */
  wasm?: boolean;
  /** Extra Vite/Vitest config, deep-merged over the defaults. */
  vite?: ViteUserConfig;
}

interface CalabPackageJson {
  calab?: { id?: string; displayName?: string };
}

/** The `calab` identity of the app in `appDir`, validated. */
export function readAppIdentity(appDir: string): { id: string; displayName: string } {
  const pkgPath = path.join(appDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as CalabPackageJson;
  const id = pkg.calab?.id;
  if (!id || !APP_ID_PATTERN.test(id)) {
    throw new Error(
      `${pkgPath}: calab.id must be a lowercase slug matching ${APP_ID_PATTERN} ` +
        `(got ${JSON.stringify(id)}). It is the app's analytics/GitHub-label id.`,
    );
  }
  return { id, displayName: pkg.calab?.displayName ?? path.basename(appDir) };
}

/**
 * Public base path. GitHub Pages serves the combined site at
 * /<repo>/<displayName>/ (scripts/combine-dist.mjs copies each app's dist to
 * its displayName); a local `build:pages` serves it from /<displayName>/; dev
 * and plain builds use /.
 */
export function appBase(displayName: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_ACTIONS) {
    const repo = env.GITHUB_REPOSITORY?.split('/')[1] || DEFAULT_PAGES_REPO;
    return `/${repo}/${displayName}/`;
  }
  if (env.CALAB_PAGES) return `/${displayName}/`;
  return '/';
}

/** Build the Vite config for the app whose directory is `appDir`. */
export function defineCalabApp(appDir: string, options: CalabAppOptions = {}): ViteUserConfig {
  const { id, displayName } = readAppIdentity(appDir);
  // The apps' former vitest.config.ts files never loaded the WASM plugin;
  // keep it out of the test pipeline so test behaviour is unchanged.
  const useWasm = options.wasm === true && !process.env.VITEST;

  const base = defineConfig({
    envDir: repoRoot,
    base: appBase(displayName),
    define: {
      __APP_ID__: JSON.stringify(id),
    },
    plugins: [solidPlugin(), ...(useWasm ? [wasm()] : [])],
    ...(useWasm ? { worker: { plugins: () => [wasm()], format: 'es' as const } } : {}),
    build: {
      target: 'esnext',
    },
    test: {
      passWithNoTests: false,
      // Vitest 4 removed environmentMatchGlobs, so state the environment
      // vite-plugin-solid defaults to. Tests that need plain Node opt in with
      // a `// @vitest-environment node` docblock.
      environment: 'jsdom',
    },
  });

  return options.vite ? mergeConfig(base, options.vite) : base;
}
