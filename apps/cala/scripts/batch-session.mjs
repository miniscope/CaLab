#!/usr/bin/env node
/**
 * Unattended cala run over one recording folder: Discover, N x Refine,
 * Extract, then Export (.npz) and Export for CaDecon, written into --out.
 *
 *   node apps/cala/scripts/batch-session.mjs --data <raw folder> --out <dir>
 *        [--tag name] [--refine-runs 1] [--port 4181] [--every 15] [--max-hours 4] [--headed]
 *        [--channel chrome]
 *        [--query compress]   appended to the app URL (Cala/?debug&compress)
 *                         `--query compress`: `status.json` then holds the compress status
 *                         at the end of Discover and of Extract, and the back-fill of
 *                         Discover's recording (waited for, up to --compress-wait s;
 *                         null: skipped, `{ arrived: false }`: none arrived in time)
 *        [--stale-build]      run although dist/ is older than a source file
 *        [--compress-wait 120]  seconds to wait after a stage for its last window to be
 *                         compressed, and then, after Discover, for its back-fill (each
 *                         wait takes up to this long); if the window is not compressed, the status is recorded with
 *                         `settled: false` and its `pending` and `windows`
 *
 * Serves dist/ (npm run build:e2e) with e2e/serve.mjs, opens Cala/?debug in
 * Chromium and drives the real UI buttons, so the result is what a user gets
 * in the browser with default settings. The save dialogs are removed, so the
 * exports arrive as downloads into --out; nothing is written into --data.
 * Writes <tag>.log (progress every --every s), <tag>.status.json (stage
 * timings, final state), screenshots, and exits non-zero on error or timeout.
 */
import { chromium } from '@playwright/test';

/* global window, document */ // page.evaluate callbacks run in the browser
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { compressSettled } from './compress-settled.mjs';

// ---- options ----
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i < 0 ? d : args[i + 1];
};
const data = opt('--data');
const out = opt('--out');
if (!data || !out) throw new Error('--data and --out are required');
const tag = opt('--tag', 'cala');
const refineRuns = Number(opt('--refine-runs', '1'));
const port = Number(opt('--port', '4181'));
const every = Number(opt('--every', '15')) * 1000;
const maxMs = Number(opt('--max-hours', '4')) * 3600_000;
const headed = args.includes('--headed');
const compressWaitMs = Number(opt('--compress-wait', '120')) * 1000;
if (!(compressWaitMs >= 0)) throw new Error('--compress-wait takes seconds');
mkdirSync(out, { recursive: true });

const logFile = join(out, `${tag}.log`);
writeFileSync(logFile, '');
const t0 = Date.now();
const stamp = () =>
  `${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 60000).toFixed(1)}m`;
const L = (s) => {
  const line = `${stamp()} ${s}`;
  console.log(line);
  appendFileSync(logFile, line + '\n');
};
const status = { tag, data, started: new Date().toISOString(), stages: {}, state: 'starting' };
const saveStatus = () =>
  writeFileSync(join(out, `${tag}.status.json`), JSON.stringify(status, null, 2));
saveStatus();

// ---- the served build must be of this checkout's sources ----
const repo = resolve(import.meta.dirname, '../../..');
/** Newest source file under `dirs` (build outputs, dependencies, tests and scripts left out). */
function newestSource(dirs) {
  let newest = { path: '', mtimeMs: 0 };
  for (const dir of dirs) {
    for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const path = join(e.parentPath, e.name);
      // Relative to the scanned folder: a checkout below a folder named `dist` must not skip all.
      const rel = `/${relative(dir, path)}`;
      if (!e.isFile() || /\/(node_modules|dist|pkg|target|scripts|__tests__)\//.test(rel)) continue;
      // Sources only: caches such as tsconfig.tsbuildinfo change without a build being due.
      if (!/\.(tsx?|mts|m?js|css|html|rs|toml|wgsl)$/.test(e.name) || /\.test\./.test(e.name))
        continue;
      const mtimeMs = statSync(path).mtimeMs;
      if (mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    }
  }
  return newest;
}
const built = statSync(join(repo, 'dist/CaLab/Cala/index.html'), {
  throwIfNoEntry: false,
})?.mtimeMs;
if (built === undefined) throw new Error('dist/CaLab/Cala is missing: run npm run build:e2e');
const newest = newestSource(
  ['apps/cala', 'crates/cala/src', 'crates/solver/src', 'packages'].map((d) => join(repo, d)),
);
// A build older than a source file is not what this checkout would give.
if (newest.mtimeMs > built && !args.includes('--stale-build')) {
  throw new Error(
    `dist/ is older than ${newest.path}: run npm run build:e2e, or pass --stale-build`,
  );
}
status.built = new Date(built).toISOString();
saveStatus();

// ---- static server for dist/ ----
const base = `http://127.0.0.1:${port}/CaLab/`;
// A server that already answers on the port belongs to another checkout: this
// run would then drive that checkout's build without any sign of it.
const taken = await fetch(base).then(
  () => true,
  () => false,
);
if (taken) throw new Error(`port ${port} is already served by another process; pass --port`);
const server = spawn(process.execPath, [join(repo, 'e2e/serve.mjs'), String(port)], {
  cwd: repo,
  stdio: 'ignore',
});
let serverExit = null;
server.on('exit', (code) => {
  serverExit = code ?? 1;
});
for (let i = 0; ; i++) {
  if (serverExit !== null) throw new Error(`static server exited with code ${serverExit}`);
  try {
    if ((await fetch(base)).ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 50) throw new Error('static server did not start');
  await new Promise((r) => setTimeout(r, 200));
}

// ---- browser ----
const udd = join(out, `udd-${tag}`);
rmSync(udd, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(udd, {
  headless: !headed,
  // System Google Chrome (real GPU / WebGPU); --channel chromium for Playwright's build.
  channel: opt('--channel', 'chrome'),
  args: [
    '--enable-unsafe-webgpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
  ],
  acceptDownloads: true,
  viewport: { width: 1600, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
let crashed = false;
page.on('pageerror', (e) => L(`[pageerror] ${e.message}`));
page.on('crash', () => {
  crashed = true;
  L('[PAGE CRASH]');
});
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    L(`[console.${m.type()}] ${m.text().slice(0, 300)}`);
});
const downloads = [];
page.on('download', async (d) => {
  // <tag>_cala.npz rather than the folder name (raw_cala.npz).
  const p = join(out, d.suggestedFilename().replace(/^.*?(_cala[^/]*\.npz)$/, `${tag}$1`));
  await d.saveAs(p);
  downloads.push(p);
  L(`saved ${p}`);
});
await page.addInitScript(() => {
  delete window.showDirectoryPicker;
  delete window.showSaveFilePicker;
});

const snap = () =>
  page
    .evaluate(() => {
      const c = window.__cala;
      if (!c) return null;
      const txt = (id) => document.querySelector(`[data-testid=${id}]`)?.textContent?.trim() ?? '';
      return {
        discover: c.pipeline.status(),
        frame: c.pipeline.processed(),
        fps: c.pipeline.fps?.() ?? 0,
        refine: c.refine.status(),
        refineFrame: c.refine.processed?.() ?? 0,
        refineRuns: Number(
          document.querySelector('[data-testid=refine-readout]')?.dataset.runs ?? 0,
        ),
        extract: c.pass2.status(),
        extractFrame: c.pass2.processed?.() ?? 0,
        cells: c.cells.library?.()?.ids.length ?? 0,
        refineEnabled: !document.querySelector('[data-testid=refine-run]')?.disabled,
        extractEnabled: !document.querySelector('[data-testid=pass2-run]')?.disabled,
        exportEnabled: !document.querySelector('[data-testid=export-npz]')?.disabled,
        motion: txt('motion-backend') || '',
        compressOn: c.compress != null,
        compress: c.compress?.status?.() ?? null,
        convergence: txt('convergence-status'),
        qc: txt('qc-counts'),
      };
    })
    .catch(() => null);

const shot = async (name) => {
  try {
    await page.screenshot({ path: join(out, `${tag}-${name}.png`) });
  } catch (e) {
    L(`screenshot ${name} failed: ${e.message}`);
  }
};

/**
 * The compress status of a finished stage. The compress worker closes its last
 * window after the stage reports done, so poll (up to --compress-wait s) until the
 * status is that stage's final one; else record what is there with `settled: false`
 * and the status's `pending` and `windows` (null when no status arrived), so the
 * reader sees how far it got.
 * Null without `?compress`; with it, also waits while no status has arrived yet.
 */
async function settledCompress(expectedSource, on, current) {
  if (!on) return null;
  const t0 = Date.now();
  let c = current;
  // An error of the compress worker ends the wait: no later status follows it.
  let error = null;
  while (!compressSettled(c, expectedSource) && !error && Date.now() - t0 < compressWaitMs) {
    await page.waitForTimeout(500);
    [c, error] = await page.evaluate(() => [
      window.__cala.compress?.status?.() ?? null,
      window.__cala.compress?.error?.() ?? null,
    ]);
  }
  if (error) L(`compress worker error: ${error}`);
  if (compressSettled(c, expectedSource) && !error) return { ...c, settled: true };
  return {
    ...c,
    settled: false,
    pending: c?.pending ?? null,
    windows: c?.windows ?? null,
    ...(error ? { error } : {}),
  };
}

/**
 * The back-fill of Discover's recording, which the app requests once the last
 * window is compressed. Extract's replay clears the windows, so a back-fill that
 * has not finished would be cut short: wait for it (up to --compress-wait s, and
 * not past an error of the compress worker). Null when the wait is skipped
 * (compression off, no cells, compress status not settled; one log line says
 * which), `{ arrived: false }` when no back-fill arrived in time.
 */
async function settledBackfill(on, cells, compress) {
  const skip = !on
    ? 'compression is off'
    : cells <= 0
      ? 'the run has no cells'
      : !compress?.settled
        ? 'the compress status did not settle'
        : null;
  if (skip) {
    L(`back-fill wait skipped: ${skip}`);
    return null;
  }
  const t0 = Date.now();
  const poll = () =>
    page.evaluate(() => [
      window.__cala.compress?.backfill?.() ?? null,
      window.__cala.compress?.error?.() ?? null,
    ]);
  let [b, error] = await poll();
  while (!b && !error && Date.now() - t0 < compressWaitMs) {
    await page.waitForTimeout(500);
    [b, error] = await poll();
  }
  if (error) L(`compress worker error: ${error}`);
  if (!b) L('no back-fill arrived');
  return b ?? { arrived: false };
}

// ---- run ----
let exitCode = 0;
try {
  const query = opt('--query', '');
  await page.goto(`${base}Cala/?debug${query ? `&${query}` : ''}`);
  await page.setInputFiles('[data-testid=folder-input]', resolve(data));
  // Started (Discover can finish within one poll on short clips), or an open error.
  await page.waitForFunction(
    () =>
      ['running', 'done', 'error'].includes(window.__cala?.pipeline.status()) ||
      document.querySelector('[role=alert]') !== null,
    null,
    { timeout: 300_000 },
  );
  const alerts = page.locator('[role=alert]');
  const alert = (await alerts.count()) ? await alerts.first().textContent() : null;
  if (alert) throw new Error(`open failed: ${alert}`);
  const info = await page
    .locator('[role=banner]')
    .textContent()
    .catch(() => '');
  L(`opened ${data}: ${info?.replace(/\s+/g, ' ').slice(0, 200)}`);
  status.stages.discover = { start: Date.now() };
  status.state = 'discover';
  saveStatus();

  let phase = 'discover';
  let refinesDone = 0;
  let exported = 0;
  for (;;) {
    await page.waitForTimeout(every);
    if (crashed) throw new Error('page crashed');
    if (Date.now() - t0 > maxMs) throw new Error(`timeout in ${phase}`);
    const s = await snap();
    if (!s) continue;
    L(
      `${phase} | discover ${s.discover} ${s.frame} @${s.fps.toFixed(0)}fps | refine ${s.refine} ${s.refineFrame} (${s.refineRuns}) | ` +
        `extract ${s.extract} ${s.extractFrame} | cells ${s.cells} | ${s.convergence.slice(0, 80)}`,
    );
    status.last = s;
    saveStatus();
    if ([s.discover, s.refine, s.extract].includes('error'))
      throw new Error(`stage error: ${JSON.stringify(s)}`);

    if (phase === 'discover' && s.discover === 'done') {
      // The slow loop finishes its last pass after the frames are read; Refine
      // (or Extract) is enabled once the library is final.
      const ready = refineRuns > 0 ? s.refineEnabled : s.extractEnabled;
      if (!ready) continue;
      status.stages.discover.end = Date.now();
      status.stages.discover.cells = s.cells;
      status.stages.discover.compress = await settledCompress('discover', s.compressOn, s.compress);
      status.stages.discover.backfill = await settledBackfill(
        s.compressOn,
        s.cells,
        status.stages.discover.compress,
      );
      await shot('discover');
      phase = refineRuns > 0 ? 'refine' : 'extract';
      if (phase === 'refine') {
        status.stages.refine = { start: Date.now() };
        await page.click('[data-testid=refine-run]');
      } else {
        status.stages.extract = { start: Date.now() };
        await page.click('[data-testid=pass2-run]');
      }
    } else if (phase === 'refine' && s.refine === 'done' && s.refineEnabled) {
      refinesDone++;
      L(
        `refine ${refinesDone} done: ${await page.locator('[data-testid=refine-readout]').textContent()}`,
      );
      if (refinesDone < refineRuns) {
        await page.click('[data-testid=refine-run]');
        await page.waitForFunction(() => window.__cala.refine.status() === 'running', null, {
          timeout: 60_000,
        });
        continue;
      }
      status.stages.refine.end = Date.now();
      status.stages.refine.runs = refinesDone;
      if (!s.extractEnabled) continue;
      phase = 'extract';
      status.stages.extract = { start: Date.now() };
      await page.click('[data-testid=pass2-run]');
    } else if (phase === 'extract' && s.extract === 'done' && s.exportEnabled) {
      status.stages.extract.end = Date.now();
      status.stages.extract.cells = s.cells;
      status.stages.extract.compress = await settledCompress('replay', s.compressOn, s.compress);
      phase = 'export';
      status.stages.export = { start: Date.now() };
      await page.locator('[data-testid=export-menu] summary').click();
      await page.click('[data-testid=export-npz]');
    } else if (phase === 'export') {
      const busy = await page.locator('[data-testid=export-progress]').count();
      const err = await page
        .locator('[data-testid=export-error]')
        .textContent()
        .catch(() => null);
      if (err) throw new Error(err);
      if (busy || downloads.length <= exported) continue;
      exported = downloads.length;
      if (exported === 1) {
        await page
          .locator('[data-testid=export-menu] summary')
          .click({ trial: false })
          .catch(() => {});
        if (!(await page.locator('[data-testid=export-cadecon]').isVisible()))
          await page.locator('[data-testid=export-menu] summary').click();
        await page.click('[data-testid=export-cadecon]');
        continue;
      }
      status.stages.export.end = Date.now();
      break;
    }
  }
  // Final views for the morning: the field of view with contours, and the QC tab.
  await page.evaluate(() =>
    document.querySelector('[data-testid=export-menu]')?.removeAttribute('open'),
  );
  await shot('final');
  await page
    .getByRole('tab', { name: 'QC', exact: true })
    .click()
    .catch(() => {});
  await page.waitForTimeout(1500);
  status.qc = await page
    .locator('[data-testid=qc-counts]')
    .textContent()
    .catch(() => '');
  await shot('final-qc');
  status.state = 'done';
  L(`DONE: ${downloads.join(', ')}`);
} catch (e) {
  exitCode = 1;
  status.state = 'failed';
  status.error = String(e?.stack ?? e);
  L(`FAILED: ${status.error}`);
  await shot('failed');
} finally {
  status.finished = new Date().toISOString();
  status.wallMin = (Date.now() - t0) / 60000;
  status.downloads = downloads;
  saveStatus();
  await ctx.close().catch(() => {});
  server.kill();
  rmSync(udd, { recursive: true, force: true });
}
process.exit(exitCode);
