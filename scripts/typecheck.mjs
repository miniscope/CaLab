#!/usr/bin/env node
/**
 * Type-check every workspace: `tsc -b` over each apps/* and packages/* dir
 * that has a tsconfig.json. New apps and packages are picked up automatically,
 * so there's no list to keep in sync. Extra CLI args go through to tsc
 * (e.g. `npm run typecheck -- --verbose`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const projects = ['packages', 'apps'].flatMap((group) =>
  readdirSync(join(repoRoot, group), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(repoRoot, group, e.name, 'tsconfig.json')))
    .map((e) => `${group}/${e.name}`)
    .sort(),
);

console.log(`[typecheck] tsc -b ${projects.join(' ')}`);
try {
  execFileSync('npx', ['tsc', '-b', ...projects, ...process.argv.slice(2)], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} catch {
  process.exit(1);
}
