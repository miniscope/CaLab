#!/usr/bin/env node
/**
 * Build the combined static site the way deploy.yml does (every app plus the
 * generated landing page, under dist/CaLab/), with a fixed offline environment
 * so the smoke suite is reproducible:
 *
 * - GITHUB_ACTIONS + GITHUB_REPOSITORY force the production base path
 *   /CaLab/<DisplayName>/ (see appBase in @calab/vite-config), so a hard-coded
 *   absolute path that would 404 on GitHub Pages also fails here.
 * - VITE_SUPABASE_* are blanked so a developer's local .env never points the
 *   suite at a real Supabase project (process env wins over .env in Vite and
 *   in combine-dist). That is the configuration CI and forks build in.
 *
 * Usage: npm run build:e2e   (needs crates/solver/pkg; the npm script runs
 * ensure-wasm first)
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const env = {
  ...process.env,
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'calab-e2e/CaLab',
  VITE_SUPABASE_URL: '',
  VITE_SUPABASE_ANON_KEY: '',
  VITE_APP_VERSION: process.env.VITE_APP_VERSION ?? 'e2e',
};

for (const script of ['scripts/build-apps.mjs', 'scripts/combine-dist.mjs']) {
  execFileSync(process.execPath, [script], { stdio: 'inherit', cwd: root, env });
}
