#!/usr/bin/env node
/**
 * `npm run dev [app] [-- vite args]`: start one app's Vite dev server.
 *
 * Apps are discovered from apps/<dir>/package.json, so there is no per-app
 * `dev:<app>` script to add. `app` may be the directory name, `calab.id` or
 * `calab.displayName` (case-insensitive); it defaults to CaTune. The root
 * `predev` hook builds the WASM solver first (scripts/ensure-wasm.mjs), which
 * `npm run dev -w apps/<dir>` alone does not.
 */
import { execFileSync } from 'node:child_process';
import { discoverApps, repoRoot } from './lib/apps.mjs';

const DEFAULT_APP = 'catune';

const argv = process.argv.slice(2);
// `npm run dev -- --port 5174` passes Vite flags with no app name.
if (argv.length === 0 || argv[0].startsWith('-')) argv.unshift(DEFAULT_APP);
const [requested, ...viteArgs] = argv;
const wanted = requested.toLowerCase();
const apps = discoverApps();
const app = apps.find((a) =>
  [a.dir, a.id, a.displayName].some((name) => name.toLowerCase() === wanted),
);

if (!app) {
  console.error(
    `[dev] unknown app ${JSON.stringify(requested)}. Apps: ${apps.map((a) => a.dir).join(', ')}\n` +
      'Usage: npm run dev [app] [-- vite args]',
  );
  process.exit(1);
}

const args = ['run', 'dev', '-w', `apps/${app.dir}`];
if (viteArgs.length > 0) args.push('--', ...viteArgs);
try {
  execFileSync('npm', args, {
    stdio: 'inherit',
    cwd: repoRoot,
    shell: process.platform === 'win32',
  });
} catch (err) {
  // Ctrl-C ends Vite with a signal; anything else is a real failure.
  process.exit(err.signal ? 0 : (err.status ?? 1));
}
