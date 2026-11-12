#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  MANIFEST_FILE,
  appsDir,
  buildManifest,
  discoverApps,
  repoRoot as root,
  siteDir,
} from './lib/apps.mjs';
import { renderLandingPage } from './lib/landing.mjs';

// dist/<repo>: the Pages project name, derived like appBase in @calab/vite-config.
const out = siteDir();

// Load .env file (same vars Vite reads for the apps)
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      let val = match[2];
      // Strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      } else {
        // Remove inline comments for unquoted values
        val = val.replace(/\s+#.*$/, '');
      }
      process.env[match[1]] = val;
    }
  }
}

mkdirSync(out, { recursive: true });

const apps = discoverApps().map((app) => {
  let screenshotFile = '';
  if (app.screenshot) {
    const screenshotPath = join(appsDir, app.dir, app.screenshot);
    if (existsSync(screenshotPath)) {
      screenshotFile = `${app.dir}-screenshot.png`;
      cpSync(screenshotPath, join(out, screenshotFile));
    }
  }
  return { ...app, screenshotFile };
});

for (const app of apps) {
  const src = resolve(appsDir, app.dir, 'dist');
  cpSync(src, resolve(out, app.path), { recursive: true });
}

// Machine-readable list of the published apps (python/src/calab/_bridge reads it).
writeFileSync(join(out, MANIFEST_FILE), JSON.stringify(buildManifest(apps), null, 2) + '\n');

writeFileSync(
  resolve(out, 'index.html'),
  renderLandingPage({
    apps,
    version: process.env.VITE_APP_VERSION ?? '',
    // Auth env vars, injected at build time
    supabaseUrl: process.env.VITE_SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY ?? '',
  }),
);

console.log(
  `Combined dist created at ${relative(root, out)}/ (${apps.length} apps, ${MANIFEST_FILE})`,
);
