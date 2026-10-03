/**
 * App discovery shared by the build scripts, so no script keeps its own list
 * of apps. An app is any `apps/<dir>/package.json` (except `_template`) with a
 * `calab.displayName`; everything else about it comes from that `calab` block.
 *
 * `apps/_template` is the source `npm run new-app` copies (scripts/new-app.mjs).
 * It is linted, type-checked and tested like an app, but never built, listed or
 * deployed: its `calab.id` is still the `__APP_ID__` placeholder, which
 * @calab/vite-config accepts only under Vitest. It is also `hidden: true`, so
 * a copy made by hand stays off the landing page until someone unhides it.
 *
 * Also owns the shape of `apps.json`, the build-time manifest combine-dist
 * writes next to the landing page and the Python bridge reads at runtime
 * (python/src/calab/_bridge/_manifest.py). Bump MANIFEST_VERSION only for a
 * change an older reader would misread; adding a field is not one.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '../..');
export const appsDir = join(repoRoot, 'apps');

/** The scaffold under apps/ that discovery and the build skip. */
export const TEMPLATE_DIR = '_template';

/**
 * Valid `calab.id` slugs: `APP_ID_PATTERN` in @calab/vite-config, the one
 * definition (it also mirrors the analytics_sessions.app_name CHECK). That
 * module is TypeScript that pulls in Vite, so plain Node scripts read the
 * literal from its source instead of keeping a copy.
 */
export const APP_ID_PATTERN = (() => {
  const src = readFileSync(join(repoRoot, 'packages/vite-config/src/index.ts'), 'utf-8');
  const m = src.match(/export const APP_ID_PATTERN = \/(.+)\/;/);
  if (!m) throw new Error('APP_ID_PATTERN not found in packages/vite-config/src/index.ts');
  return new RegExp(m[1]);
})();

/** File name of the manifest, at the root of the combined site. */
export const MANIFEST_FILE = 'apps.json';
export const MANIFEST_VERSION = 1;

/** Landing-page (and manifest) order: stable, then beta, then coming-soon. */
const STATUS_ORDER = { stable: 0, beta: 1, 'coming-soon': 2 };

/** Fallback when not on GitHub Actions; mirrors DEFAULT_PAGES_REPO in @calab/vite-config. */
const DEFAULT_PAGES_REPO = 'CaLab';

/**
 * The GitHub Pages project name: the site is served at /<repo>/ and combine-dist
 * writes it to dist/<repo>/. Derived like `appBase` in @calab/vite-config.
 */
export function pagesRepoName(env = process.env) {
  return env.GITHUB_REPOSITORY?.split('/')[1] || DEFAULT_PAGES_REPO;
}

/** Output directory of the combined site (dist/<repo>). */
export function siteDir(env = process.env) {
  return join(repoRoot, 'dist', pagesRepoName(env));
}

/**
 * Every app with a `calab.displayName`, hidden ones included, in landing order.
 * `path` is the URL segment the app is deployed under (its displayName).
 */
export function discoverApps() {
  return readdirSync(appsDir)
    .filter((dir) => dir !== TEMPLATE_DIR && statSync(join(appsDir, dir)).isDirectory())
    .flatMap((dir) => {
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(appsDir, dir, 'package.json'), 'utf-8'));
      } catch {
        return [];
      }
      const meta = pkg.calab;
      if (meta?.displayName == null) return [];
      return [
        {
          dir,
          id: meta.id ?? dir,
          displayName: meta.displayName,
          path: meta.displayName,
          description: meta.description ?? '',
          longDescription: meta.longDescription ?? '',
          features: meta.features ?? [],
          status: meta.status ?? 'coming-soon',
          hidden: meta.hidden ?? false,
          screenshot: meta.screenshot ?? '',
        },
      ];
    })
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99));
}

/** Run git, returning trimmed stdout or null (no git, not a checkout, no match). */
function git(...args) {
  try {
    return (
      execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The CaLab release being built: the `v*` tag when building on one (GitHub's
 * GITHUB_REF_NAME on a tag push, else a tag pointing at HEAD), otherwise the
 * commit sha.
 */
export function releaseInfo(env = process.env) {
  const commit = env.GITHUB_SHA || git('rev-parse', 'HEAD');
  const refTag =
    env.GITHUB_REF_TYPE === 'tag' && /^v\d/.test(env.GITHUB_REF_NAME ?? '')
      ? env.GITHUB_REF_NAME
      : null;
  const tag = refTag ?? git('describe', '--tags', '--exact-match', '--match', 'v[0-9]*', 'HEAD');
  return { release: tag ?? commit ?? 'unknown', commit: commit ?? null };
}

/** The `apps.json` document for `apps` (as returned by discoverApps). */
export function buildManifest(apps, env = process.env) {
  const epoch = Number(env.SOURCE_DATE_EPOCH);
  const generatedAt = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date();
  return {
    manifest_version: MANIFEST_VERSION,
    ...releaseInfo(env),
    generated_at: generatedAt.toISOString(),
    apps: apps
      .filter((app) => !app.hidden)
      .map(({ id, displayName, path, description, status }) => ({
        id,
        displayName,
        path,
        description,
        status,
      })),
  };
}
