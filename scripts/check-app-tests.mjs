#!/usr/bin/env node
/**
 * Fail if any apps/* workspace with a package.json has no `test` script.
 *
 * The root `npm test` runs `npm run test --workspaces --if-present`, so an app
 * without a `test` script is skipped silently and CI stays green. This check
 * makes the omission loud. Apps are discovered the same way scripts/typecheck.mjs
 * discovers projects, so there is no list to keep in sync.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appsDir = join(repoRoot, 'apps');

const apps = readdirSync(appsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(appsDir, e.name, 'package.json')))
  .map((e) => e.name)
  .sort();

const missing = apps.filter((name) => {
  const pkg = JSON.parse(readFileSync(join(appsDir, name, 'package.json'), 'utf8'));
  const test = pkg.scripts?.test;
  return typeof test !== 'string' || test.trim() === '';
});

if (missing.length > 0) {
  console.error(
    `[check-app-tests] apps without a "test" script (npm test would skip them silently):\n` +
      missing.map((name) => `  - apps/${name}/package.json`).join('\n') +
      `\nAdd one, e.g. "test": "vitest run --passWithNoTests" until the app has tests.`,
  );
  process.exit(1);
}

console.log(`[check-app-tests] ok: ${apps.length} apps have a test script (${apps.join(', ')})`);
