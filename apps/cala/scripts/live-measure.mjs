#!/usr/bin/env node
/**
 * Measure a live run of the cala app against a file run, headless, with
 * Playwright's Chromium, on a synthetic MiniMe session (local only; needs the
 * dev server: `npm run dev cala` and the session on disk).
 *
 *   node apps/cala/scripts/live-measure.mjs <session>/raw --url http://localhost:5207
 *        --out <dir> [--mode live|file|both] [--fps 20] [--port 8766] [--headed]
 *        [--python <minime venv python>]
 *
 * `live`: starts `live-sim.mjs` on the folder, opens the app on it with
 * `?live=...&compress&debug`, waits for the run to end and the final back-fill,
 * writes `live_metrics.json` (frames received / processed / dropped per stage,
 * the fast and slow loops' lag behind the stream, windows waiting on disk over
 * time, every back-fill and its cost) and the export `live_cala.npz` (the
 * back-filled traces). `file`: opens the folder through the directory input,
 * lets pass 1 and pass 2 run, writes `file_metrics.json` and `file_cala.npz`.
 * With `--python`, both exports are scored against `<session>/meta.json` by
 * `score_cala_export.py` into `<name>_score.json`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

/* global window */ // the page.evaluate callbacks run in the browser

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value ?? fallback;
}
function flag(name) {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}
const url = option('--url', 'http://localhost:5207').replace(/\/$/, '');
const out = resolve(option('--out', 'live-measure-out'));
const mode = option('--mode', 'both');
const fps = option('--fps', undefined);
const port = Number(option('--port', '8766'));
const python = option('--python', undefined);
const headed = flag('--headed');
const folder = resolve(args[0] ?? '.');
const meta = join(dirname(folder), 'meta.json');
mkdirSync(out, { recursive: true });
const here = import.meta.dirname;

const summarize = (v) => {
  if (v.length === 0) return { n: 0, mean: 0, p50: 0, p99: 0, max: 0 };
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: q(0.5),
    p99: q(0.99),
    max: s[s.length - 1],
  };
};

/** Poll `fn` in the page every 500 ms until it is truthy. */
async function until(page, fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function exportNpz(page, path) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-testid=export-npz]'),
  ]);
  await download.saveAs(path);
}

/** What both runs report. */
const pipelineMetrics = () => {
  const c = window.__cala;
  const p = c.pipeline;
  const cells = c.cells;
  const m = cells.metrics();
  return {
    status: p.status(),
    processed: p.processed(),
    plan: p.plan(),
    motionBackend: p.motionBackend(),
    meanFps: p.fps(),
    stageMs: p.stageMs(),
    stageBusy: p.stageBusy(),
    cells: cells.library()?.ids.length ?? 0,
    libraryVersion: cells.library()?.version ?? 0,
    slowFinal: cells.status()?.final ?? false,
    slowLag: m.lag.filter((v) => v !== null),
    slowLagFrame: m.frame,
    forwarded: cells.batch()?.forwardedFrames ?? 0,
    slowDropped: cells.batch()?.droppedFrames ?? 0,
    libraries: cells.events().map((e) => ({ version: e.version, frame: e.frame, cells: e.cells })),
    fastMs: cells.timing().on.concat(cells.timing().off),
  };
};

async function liveRun(browser) {
  const sim = spawn(
    process.execPath,
    [join(here, 'live-sim.mjs'), folder, '--port', String(port), ...(fps ? ['--fps', fps] : [])],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const simLog = [];
  sim.stdout.on('data', (d) => {
    const s = d.toString();
    simLog.push(s);
    process.stdout.write(`  ${s}`);
  });
  await new Promise((r, j) => {
    sim.stdout.on('data', (d) => d.toString().includes('listening') && r());
    sim.on('exit', (code) => j(new Error(`live-sim exited with ${code}`)));
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    const t0 = Date.now();
    await page.goto(`${url}/?live=ws://localhost:${port}&compress&debug`);
    await until(page, () => window.__cala?.pipeline.status() === 'running', 30_000, 'the live run');
    console.log('live run started');
    await until(
      page,
      () => window.__cala.pipeline.status() === 'done',
      20 * 60_000,
      'the end of the stream',
    );
    console.log('stream ended; waiting for the final back-fill');
    await until(
      page,
      () => {
        const c = window.__cala;
        const final = c.cells.status()?.final;
        const b = c.compress.backfill();
        return (
          (final && b && b.version === c.cells.library()?.version) ||
          c.pipeline.status() === 'error'
        );
      },
      5 * 60_000,
      'the final back-fill',
    );
    const seconds = (Date.now() - t0) / 1000;
    const raw = await page.evaluate(() => {
      const c = window.__cala;
      return {
        pipeline: (0, eval)(`(${window.__pipelineMetrics})`)(),
        error: c.pipeline.error(),
        livePoints: c.pipeline.livePoints(),
        live: c.pipeline.live(),
        compressStatus: c.compress.status(),
        compressHistory: c.compress.history(),
        backfills: c.compress.backfills(),
        compressError: c.compress.error(),
        result: (() => {
          const r = c.compress.result();
          return r ? { frames: r.frames, cells: r.cells, version: r.version } : null;
        })(),
      };
    });
    const lp = raw.livePoints;
    const t00 = lp[0]?.t ?? 0;
    // The processing walk starts behind by the warm-up frames; when did it catch up?
    const caughtUp = lp.findIndex((p) => p.lagFrames <= 8);
    const steady = caughtUp >= 0 ? lp.slice(caughtUp) : [];
    const pendingOverTime = raw.compressHistory.map((h) => ({
      t: (h.t - t00) / 1000,
      windows: h.windows,
      pending: h.pending,
      pendingFrames: h.pendingFrames,
      msPerFrame: h.msPerFrame,
    }));
    const metrics = {
      mode: 'live',
      seconds,
      error: raw.error ?? raw.compressError,
      received: raw.live.received,
      missedAtSource: raw.live.missed,
      droppedByQueue: raw.live.dropped,
      processed: raw.pipeline.processed,
      slowForwarded: raw.pipeline.forwarded,
      slowDropped: raw.pipeline.slowDropped,
      compressed: { windows: raw.compressStatus.windows, frames: raw.compressStatus.frames },
      backfilled: raw.result,
      fastLagFrames: summarize(lp.map((p) => p.lagFrames)),
      fastLagMs: summarize(lp.map((p) => p.lagMs)),
      queued: summarize(lp.map((p) => p.queued)),
      catchUp: {
        startLagFrames: lp[0]?.lagFrames ?? 0,
        seconds: caughtUp >= 0 ? (lp[caughtUp].t - t00) / 1000 : null,
        atFrame: caughtUp >= 0 ? lp[caughtUp].frame : null,
      },
      steadyFastLagFrames: summarize(steady.map((p) => p.lagFrames)),
      steadyFastLagMs: summarize(steady.map((p) => p.lagMs)),
      lagOverTime: lp.map((p) => ({
        t: Math.round((p.t - t00) / 100) / 10,
        frame: p.frame,
        lagFrames: p.lagFrames,
        lagMs: Math.round(p.lagMs),
        queued: p.queued,
      })),
      slowLagFrames: summarize(raw.pipeline.slowLag),
      slowBehindStreamFrames: summarize(
        raw.pipeline.slowLag.map((v, i) => v + (lp[Math.min(i, lp.length - 1)]?.lagFrames ?? 0)),
      ),
      pendingWindows: {
        max: Math.max(0, ...pendingOverTime.map((p) => p.pending)),
        points: pendingOverTime,
      },
      backfills: raw.backfills.map((b) => ({
        version: b.version,
        frames: b.frames,
        windows: b.windows,
        msPerFrame: b.msPerFrame,
        seconds: (b.doneMs - b.requestedMs) / 1000,
        atSeconds: (b.requestedMs - t00) / 1000,
      })),
      pipeline: {
        ...raw.pipeline,
        slowLag: undefined,
        slowLagFrame: undefined,
        fastMs: summarize(raw.pipeline.fastMs),
      },
      libraries: raw.pipeline.libraries,
      simLog,
    };
    writeFileSync(join(out, 'live_metrics.json'), JSON.stringify(metrics, null, 1));
    if (raw.result) await exportNpz(page, join(out, 'live_cala.npz'));
    await page.close();
    return metrics;
  } finally {
    sim.kill();
  }
}

async function fileRun(browser) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${url}/?debug`);
  await page.setInputFiles('[data-testid=folder-input]', folder);
  const t0 = Date.now();
  await until(page, () => window.__cala?.pipeline.status() === 'running', 60_000, 'the file run');
  console.log('file run started');
  await until(page, () => window.__cala.pipeline.status() === 'done', 20 * 60_000, 'pass 1');
  const pass1Seconds = (Date.now() - t0) / 1000;
  console.log('pass 1 done; waiting for pass 2');
  await until(
    page,
    () => ['done', 'error'].includes(window.__cala.pass2.status()),
    10 * 60_000,
    'pass 2',
  );
  const raw = await page.evaluate(() => {
    const c = window.__cala;
    const r = c.pass2.result();
    return {
      pipeline: (0, eval)(`(${window.__pipelineMetrics})`)(),
      pass2: {
        status: c.pass2.status(),
        error: c.pass2.error(),
        frames: r?.frames,
        cells: r?.cells,
        seconds: r?.seconds,
        version: r?.version,
      },
    };
  });
  const metrics = {
    mode: 'file',
    pass1Seconds,
    processed: raw.pipeline.processed,
    slowForwarded: raw.pipeline.forwarded,
    slowDropped: raw.pipeline.slowDropped,
    slowLagFrames: summarize(raw.pipeline.slowLag),
    pass2: raw.pass2,
    pipeline: {
      ...raw.pipeline,
      slowLag: undefined,
      slowLagFrame: undefined,
      fastMs: summarize(raw.pipeline.fastMs),
    },
    libraries: raw.pipeline.libraries,
  };
  writeFileSync(join(out, 'file_metrics.json'), JSON.stringify(metrics, null, 1));
  if (raw.pass2.status === 'done') await exportNpz(page, join(out, 'file_cala.npz'));
  await page.close();
  return metrics;
}

function scoreExport(name) {
  if (!python) return;
  const r = spawnSync(
    python,
    [
      join(here, 'score_cala_export.py'),
      join(out, `${name}_cala.npz`),
      meta,
      '--json',
      join(out, `${name}_score.json`),
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) console.error(`scoring ${name} failed`);
}

const browser = await chromium.launch({
  headless: !headed,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist'],
});
try {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(`window.__pipelineMetrics = ${pipelineMetrics.toString()};`);
  if (mode === 'live' || mode === 'both') {
    const m = await liveRun(context);
    console.log(
      `live: received ${m.received}, processed ${m.processed}, dropped ${m.droppedByQueue} (queue) + ${m.missedAtSource} (source); ` +
        `fast lag mean ${m.fastLagFrames.mean.toFixed(1)} / p99 ${m.fastLagFrames.p99} / max ${m.fastLagFrames.max} frames ` +
        `(starts ${m.catchUp.startLagFrames} behind, caught up after ${m.catchUp.seconds?.toFixed(1)} s; then p99 ${m.steadyFastLagFrames.p99} frames, ${m.steadyFastLagMs.p99.toFixed(0)} ms); ` +
        `slow lag mean ${m.slowLagFrames.mean.toFixed(1)} / max ${m.slowLagFrames.max}; ` +
        `windows waiting max ${m.pendingWindows.max}; back-fills ${m.backfills.length}; ${m.pipeline.cells} cells`,
    );
    scoreExport('live');
  }
  if (mode === 'file' || mode === 'both') {
    const m = await fileRun(context);
    console.log(
      `file: pass 1 ${m.processed} frames in ${m.pass1Seconds.toFixed(0)} s; pass 2 ${m.pass2.status} ` +
        `(${m.pass2.frames} frames x ${m.pass2.cells} cells in ${m.pass2.seconds?.toFixed(1)} s); slow lag mean ${m.slowLagFrames.mean.toFixed(1)}`,
    );
    scoreExport('file');
  }
} finally {
  await browser.close();
}
