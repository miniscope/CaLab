#!/usr/bin/env node
/**
 * `npm run new-app <id> <DisplayName>`
 * `npm run new-app -- <id> <DisplayName> [--wasm] [--status <status>] [--no-install]`
 * (npm needs the `--` to pass flags through to the script.)
 *
 * Copy apps/_template to apps/<id> and fill it in, so the new app runs, tests,
 * lints, builds and gets a landing-page card with no further edits:
 *
 * - package.json: `name` and `calab.id` = <id>, `calab.displayName`,
 *   `calab.status` (default coming-soon), `calab.hidden` = false;
 * - every text file: `__APP_DISPLAY_NAME__` -> <DisplayName> and, in the
 *   README, `__APP_DIR__` -> <id>. Source code keeps the `__APP_ID__` global,
 *   which @calab/vite-config defines from `calab.id` at build time;
 * - `--wasm`: `defineCalabApp(import.meta.dirname, { wasm: true })`;
 * - prettier over the new directory, then `npm install` to link the workspace
 *   (skip with `--no-install`).
 *
 * See docs/NEW_APP.md.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { APP_ID_PATTERN, TEMPLATE_DIR, appsDir, discoverApps, repoRoot } from './lib/apps.mjs';

/** The display name is also the URL segment (/CaLab/<DisplayName>/) and Vite base. */
const DISPLAY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const STATUSES = ['stable', 'beta', 'coming-soon'];
const USAGE =
  'Usage: npm run new-app -- <id> <DisplayName> [--wasm] [--status stable|beta|coming-soon] [--no-install]\n' +
  '  e.g. npm run new-app caview CaView';

function die(msg) {
  console.error(`[new-app] ${msg}\n${USAGE}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      wasm: { type: 'boolean', default: false },
      status: { type: 'string', default: 'coming-soon' },
      'no-install': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (err) {
  die(err.message);
}
const { values: opts, positionals } = parsed;
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length !== 2) die('expected an id and a display name.');
const [id, displayName] = positionals;

if (!APP_ID_PATTERN.test(id)) {
  die(`id ${JSON.stringify(id)} must match ${APP_ID_PATTERN} (lowercase slug, 2-32 chars).`);
}
if (!DISPLAY_NAME_PATTERN.test(displayName)) {
  die(
    `display name ${JSON.stringify(displayName)} must match ${DISPLAY_NAME_PATTERN}: ` +
      'it is the URL path (/CaLab/<DisplayName>/), so no spaces. Use PascalCase, e.g. CaView.',
  );
}
if (!STATUSES.includes(opts.status)) die(`--status must be one of ${STATUSES.join(', ')}.`);

// Results-route segments of the Python bridge that are not app slugs
// (RESERVED_SLUGS in python/src/calab/_bridge/_registry.py).
if (id === 'activity') die('"activity" is reserved by the Python bridge.');

const dest = join(appsDir, id);
if (existsSync(dest)) die(`${relative(repoRoot, dest)} already exists.`);
for (const app of discoverApps()) {
  if (app.id === id) die(`apps/${app.dir} already uses id ${JSON.stringify(id)}.`);
  if (app.displayName.toLowerCase() === displayName.toLowerCase()) {
    die(`apps/${app.dir} already uses display name ${JSON.stringify(app.displayName)}.`);
  }
}

// --- Copy, skipping anything generated inside the template ---
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.vite']);
const src = join(appsDir, TEMPLATE_DIR);
cpSync(src, dest, {
  recursive: true,
  filter: (path) => !SKIP.has(basename(path)) && !path.endsWith('.tsbuildinfo'),
});

// --- package.json ---
const pkgPath = join(dest, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
pkg.name = id;
pkg.calab = { ...pkg.calab, id, displayName, status: opts.status, hidden: false };
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// --- Placeholders in every other text file ---
const TEXT_EXT = /\.(tsx?|css|html|md|json)$/;
function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (TEXT_EXT.test(name)) yield path;
  }
}
for (const file of files(dest)) {
  const text = readFileSync(file, 'utf-8');
  const out = text
    .replaceAll('__APP_DISPLAY_NAME__', displayName)
    .replaceAll('__APP_DIR__', id)
    // Keeps prettier from reading `# __APP_DISPLAY_NAME__` as bold in the template only.
    .replace(/^<!-- prettier-ignore -->\n(?=# )/m, '');
  if (out !== text) writeFileSync(file, out);
}

// --- Optional WASM plugin ---
if (opts.wasm) {
  writeFileSync(
    join(dest, 'vite.config.ts'),
    "import { defineCalabApp } from '@calab/vite-config';\n\n" +
      'export default defineCalabApp(import.meta.dirname, { wasm: true });\n',
  );
}

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });

// A longer display name can push a line past the print width.
run('npx', ['prettier', '--log-level', 'warn', '--write', relative(repoRoot, dest)]);

if (!opts['no-install']) {
  console.log('\n[new-app] npm install (links the new workspace)');
  run('npm', ['install', '--no-audit', '--no-fund']);
}

console.log(`
[new-app] Created apps/${id} (${displayName}, ${opts.status}${opts.wasm ? ', wasm' : ''}).

Next steps:
  npm run dev ${id}                # dev server
  npm test -w apps/${id}           # unit tests (src/__tests__/App.test.tsx)
  npm run build:apps && node scripts/combine-dist.mjs   # landing page + apps.json in dist/

  - Fill in description, longDescription, features and screenshot in
    apps/${id}/package.json (the landing-page card).
  - Add a browser smoke test at e2e/${id}.spec.ts (see e2e/README.md,
    "Adding a spec for a new app"); e2e/landing.spec.ts already covers the card.
  - Commit apps/${id} and the package-lock.json change.${opts['no-install'] ? '\n  - Run `npm install` to link the workspace.' : ''}
`);
