#!/usr/bin/env node
/**
 * Build every apps/<dir> with a `build` script, hidden apps included: a hidden
 * app is deployed at its URL, it just gets no landing card or apps.json entry
 * (see scripts/combine-dist.mjs). `apps/_template` is skipped on purpose; its
 * `calab.id` is a placeholder that @calab/vite-config refuses outside Vitest
 * (see TEMPLATE_DIR in scripts/lib/apps.mjs).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TEMPLATE_DIR, appsDir, repoRoot as root } from './lib/apps.mjs';

const apps = readdirSync(appsDir).filter((name) => {
  if (name === TEMPLATE_DIR) return false;
  const dir = join(appsDir, name);
  if (!statSync(dir).isDirectory()) return false;
  const pkgPath = join(dir, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.scripts?.build != null;
  } catch {
    return false;
  }
});

if (apps.length === 0) {
  console.error('No buildable apps found in apps/');
  process.exit(1);
}

console.log(`Building ${apps.length} apps: ${apps.join(', ')}`);

for (const name of apps) {
  console.log(`\nBuilding ${name}...`);
  execFileSync('npm', ['run', 'build', '-w', `apps/${name}`], {
    stdio: 'inherit',
    cwd: root,
  });
}

console.log('\nAll apps built successfully.');
