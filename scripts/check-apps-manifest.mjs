#!/usr/bin/env node
/**
 * Fail unless the combined site (dist/<repo>/, written by combine-dist.mjs)
 * has an apps.json that lists exactly the non-hidden apps, each with a built
 * index.html under its path. The Python bridge reads this file from the
 * deployed site to learn app URLs, so a missing or stale manifest is a bug.
 *
 * Usage: node scripts/combine-dist.mjs && node scripts/check-apps-manifest.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MANIFEST_FILE, MANIFEST_VERSION, discoverApps, repoRoot, siteDir } from './lib/apps.mjs';

const site = siteDir();
const file = join(site, MANIFEST_FILE);
const errors = [];
const fail = (msg) => errors.push(msg);

if (!existsSync(file)) {
  console.error(`[check-apps-manifest] ${relative(repoRoot, file)} is missing; run combine-dist.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(file, 'utf-8'));
if (manifest.manifest_version !== MANIFEST_VERSION) {
  fail(`manifest_version is ${manifest.manifest_version}, expected ${MANIFEST_VERSION}`);
}
if (typeof manifest.release !== 'string' || manifest.release === '') fail('release is empty');
if (Number.isNaN(Date.parse(manifest.generated_at))) fail('generated_at is not a date');
if (!Array.isArray(manifest.apps)) fail('apps is not an array');

const expected = discoverApps().filter((app) => !app.hidden);
const listed = Array.isArray(manifest.apps) ? manifest.apps : [];
const fields = ['id', 'displayName', 'path', 'description', 'status'];

for (const app of expected) {
  const entry = listed.find((e) => e.id === app.id);
  if (!entry) {
    fail(`apps/${app.dir} (id ${app.id}) is not listed`);
    continue;
  }
  for (const key of fields) {
    if (entry[key] !== app[key]) {
      fail(
        `${app.id}.${key} is ${JSON.stringify(entry[key])}, expected ${JSON.stringify(app[key])}`,
      );
    }
  }
  if (!existsSync(join(site, app.path, 'index.html'))) {
    fail(`${app.id}: ${relative(repoRoot, join(site, app.path))}/index.html is missing`);
  }
}
for (const entry of listed) {
  if (!expected.some((app) => app.id === entry.id)) {
    fail(`lists ${JSON.stringify(entry.id)}, which is hidden or not an app`);
  }
}

if (errors.length > 0) {
  console.error(
    `[check-apps-manifest] ${relative(repoRoot, file)} is wrong:\n` +
      errors.map((e) => `  - ${e}`).join('\n'),
  );
  process.exit(1);
}
console.log(
  `[check-apps-manifest] ok: ${listed.length} apps (${listed.map((e) => e.id).join(', ')}), ` +
    `release ${manifest.release}`,
);
