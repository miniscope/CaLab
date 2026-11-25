#!/usr/bin/env node
/**
 * Measure a live run of the cala app, headless, with Playwright's Chromium,
 * on a Miniscope folder (local only; needs the dev server `npm run dev cala`
 * and the recording on disk). Optionally the same folder as a file run, for
 * the comparison.
 *
 *   node apps/cala/scripts/live-measure.mjs <folder> --url http://localhost:5207
 *        --out <dir> [--mode live|file|both] [--fps 20] [--port 8766] [--headed]
 *        [--query factors=0] [--frames N] [--tag NAME] [--channel chrome] [--user-data-dir DIR]
 *
 * `live`: starts `live-sim.mjs` on the folder, opens the app on it with
 * `?live=...&debug`, waits for the stream to end and the final library, and
 * writes `live_metrics.json` (frames received / processed / dropped per
 * stage, the fast and slow loops' lag behind the stream, batch by batch) and
 * the export `live_cala.npz` (the live traces). `file`: opens the folder
 * (pass 1 now includes look-back and its Final settle: look-back is on by default; add ?lookback=0
 * for plain Discover timing) through the directory input, lets pass 1 and pass 2 run, and writes
 * `file_metrics.json` and `file_cala.npz`.
 *
 * `--query` adds URL parameters to the run (live or file; `factors=file`: a
 * recording's settle and Extract may read its factors, summed up in the file
 * metrics' `factors`). A live run settles and extracts on its factors after
 * the stream ends by default, and the script then also waits for Extract;
 * `factors=0` runs the stream on Discover only. `--user-data-dir <dir>` runs
 * a persistent browser profile there, so OPFS (the factors) lives on that
 * disk; the folder is emptied first. `--frames N` streams only the first N frames; `--tag` names the
 * output files (`<tag>_metrics.json`, `<tag>_cala.npz`); `--channel chrome`
 * runs the installed Google Chrome. Every second the live run samples the
 * compressor's status, the slow loop's settle and Extract (`timeline`), from
 * which `factors` sums up the compressor's pace and queue, and the wait,
 * settle and Extract times after the stream (also per minute of stream).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

/* global window, document */ // the page.evaluate callbacks run in the browser

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
const mode = option('--mode', 'live');
const fps = option('--fps', undefined);
const port = Number(option('--port', '8766'));
const headed = flag('--headed');
const query = option('--query', '');
const frames = option('--frames', undefined);
const tag = option('--tag', 'live');
const channel = option('--channel', undefined);
const userDataDir = option('--user-data-dir', undefined);
const folder = resolve(args[0] ?? '.');
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
  // The export buttons sit in a menu: open it first.
  const menu = page.locator('[data-testid=export-menu]');
  if (!(await menu.evaluate((el) => el.open))) await menu.locator('summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-testid=export-npz]'),
  ]);
  await download.saveAs(path);
}

/** What both runs report (runs in the page). */
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
    forwarded: cells.batch()?.forwardedFrames ?? 0,
    slowDropped: cells.batch()?.droppedFrames ?? 0,
    libraries: cells.events().map((e) => ({ version: e.version, frame: e.frame, cells: e.cells })),
    fastMs: cells.timing().on.concat(cells.timing().off),
  };
};

// A live stream is a factor run by default; `factors=0` (or `compress&review`) turns it off.
const qp = new URLSearchParams(query);
const factorRun = qp.get('factors') !== '0' && !(qp.has('compress') && qp.has('review'));

/** One timeline sample of the live run (runs in the page). */
const sample = () => {
  const c = window.__cala;
  const cs = c.compress?.status() ?? null;
  const st = c.cells.status();
  const settle = st?.lookback?.settle ?? null;
  return {
    pipeline: c.pipeline.status(),
    processed: c.pipeline.processed(),
    slowDropped: c.cells.batch()?.droppedFrames ?? 0,
    compress: cs && {
      windows: cs.windows,
      frames: cs.frames,
      pending: cs.pending,
      pendingFrames: cs.pendingFrames,
      msPerFrame: cs.msPerFrame,
      final: cs.final,
      workers: cs.workers ?? 1,
      fps: cs.fps ?? null,
      backlogBytes: cs.backlogBytes ?? null,
      backlogPeakBytes: cs.backlogPeakBytes ?? null,
      behindAtEnd: cs.behindAtEnd ?? null,
      fpsAfter: cs.fpsAfter ?? null,
      // Frames per window, where they are compressed, and `?debug&gpucheck`'s sums.
      window: cs.window ?? null,
      ring: cs.ring ?? null,
      backend: cs.backend ?? null,
      check: cs.check ?? null,
    },
    compressError: c.compress?.error?.() ?? null,
    final: st?.final ?? false,
    settle: settle && {
      waiting: settle.waiting ?? false,
      fed: settle.fed,
      total: settle.total,
      done: settle.done,
      source: settle.source ?? null,
      fileReason: settle.fileReason ?? null,
      workers: settle.workers ?? null,
    },
    pass2: c.pass2.status(),
    pass2Source: c.pass2.result()?.source ?? null,
    // Extract on the factor extractor: windows projected, rebuilt, and its workers (slice 6).
    pass2Extractor: c.pass2.result()?.extractor ?? null,
    pass2Reason: c.pass2.result()?.sourceReason ?? c.pass2.fileReason?.() ?? null,
    pass2Processed: c.pass2.processed(),
  };
};

/**
 * The speed check's numbers from the timeline (spec decision 6): the
 * compressor's pace and queue, and the times after the stream ended.
 */
function factorSummary(timeline, streamFrames, streamFps) {
  const first = (pred) => timeline.find(pred)?.t ?? null;
  const streamEnd = first((s) => s.pipeline === 'done' || s.pipeline === 'error');
  const during = timeline.filter((s) => streamEnd === null || s.t <= streamEnd);
  // The compressor's compute per frame, one value per window (its status after that window).
  const perWindow = new Map();
  for (const s of timeline)
    if (s.compress?.windows > 0) perWindow.set(s.compress.windows, s.compress.msPerFrame);
  const ms = [...perWindow.values()].filter((v) => v > 0);
  const lastCompressed = first((s) => s.compress?.final === true);
  const waitEnd = first((s) => s.settle && !s.settle.waiting && s.t >= (streamEnd ?? 0));
  const finalAt = first((s) => s.final);
  const extractStart = first((s) => s.pass2 === 'running');
  const extractEnd = first((s) => ['done', 'error', 'cancelled'].includes(s.pass2));
  const minutes = streamFrames / streamFps / 60;
  const span = (a, b) => (a !== null && b !== null ? b - a : null);
  const perMin = (v) => (v !== null && minutes > 0 ? v / minutes : null);
  const settleS = span(waitEnd, finalAt);
  const extractS = span(extractStart, extractEnd);
  const atEnd = timeline.find((s) => s.t === streamEnd) ?? null;
  return {
    streamMinutes: minutes,
    compressorMsPerFrame: summarize(ms),
    pendingWindowsWhileStreaming: summarize(during.map((s) => s.compress?.pending ?? 0)),
    pendingAtStreamEnd: atEnd?.compress?.pending ?? null,
    pendingFramesAtStreamEnd: atEnd?.compress?.pendingFrames ?? null,
    lastWindowAfterStreamS: span(streamEnd, lastCompressed),
    slowDropped: timeline.at(-1)?.slowDropped ?? 0,
    waitForFactorsS: span(streamEnd, waitEnd),
    settleS,
    settleFed: timeline.at(-1)?.settle?.fed ?? null,
    extractS,
    extractFrames: timeline.at(-1)?.pass2Processed ?? null,
    settleSPerMinute: perMin(settleS),
    extractSPerMinute: perMin(extractS),
    extractor: timeline.at(-1)?.pass2Extractor ?? null,
    endToExtractDoneS: span(streamEnd, extractEnd),
  };
}

/**
 * A `?factors=file` recording (slice 3): which source the settle and Extract
 * took and why, the compressor's lag at Discover's end, and the times.
 */
function fileFactorSummary(timeline) {
  const first = (pred) => timeline.find(pred) ?? null;
  const end = first((s) => s.pipeline === 'done' || s.pipeline === 'error');
  const ask = first((s) => s.settle?.waiting === true);
  const settleStart = first(
    (s) => s.settle && !s.settle.waiting && !s.final && (end ? s.t >= end.t : true),
  );
  const finalAt = first((s) => s.final);
  const extractStart = first((s) => s.pass2 === 'running');
  const extractEnd = first((s) => ['done', 'error', 'cancelled'].includes(s.pass2));
  const last = timeline.at(-1) ?? null;
  const lag = (s) => (s && s.compress ? s.processed - s.compress.frames : s ? s.processed : null);
  const span = (a, b) => (a && b ? b.t - a.t : null);
  return {
    discoverEndS: end?.t ?? null,
    compressBehindAtDiscoverEnd: lag(end),
    compressBehindAtAsk: lag(ask),
    askS: span(ask, settleStart),
    settleSource: last?.settle?.source ?? null,
    settleFileReason: last?.settle?.fileReason ?? null,
    settleS: span(settleStart ?? ask, finalAt),
    settleFed: last?.settle?.fed ?? null,
    // Look-back workers that answered the settle (worker 0 alone, or the settle pool on factors).
    settleWorkers: last?.settle?.workers ?? null,
    extractSource: last?.pass2Source ?? null,
    extractor: last?.pass2Extractor ?? null,
    extractReason: last?.pass2Reason ?? null,
    extractS: span(extractStart, extractEnd),
    compressorMsPerFrame: last?.compress?.msPerFrame ?? null,
    lastWindowCompressedS: first((s) => s.compress?.final === true)?.t ?? null,
    endToExtractDoneS: span(end, extractEnd),
    // The compress pool (slice 5): workers in use, pace before and after Discover's end, the backlog.
    compressWorkersMax: Math.max(1, ...timeline.map((s) => s.compress?.workers ?? 1)),
    compressFpsDuringDiscover: end
      ? (timeline.filter((s) => s.t <= end.t && s.compress?.fps).at(-1)?.compress.fps ?? null)
      : null,
    compressFpsAfter: last?.compress?.fpsAfter ?? null,
    compressBehindAtEnd: last?.compress?.behindAtEnd ?? null,
    compressBacklogPeakBytes: Math.max(
      0,
      ...timeline.map((s) => s.compress?.backlogPeakBytes ?? 0),
    ),
    // `?factors=gpu`: frames per window, the backend, the compressor's error, `?debug&gpucheck`.
    compressWindow: last?.compress?.window ?? null,
    compressRing: last?.compress?.ring ?? null,
    compressBackend: last?.compress?.backend ?? null,
    compressError: timeline.find((s) => s.compressError)?.compressError ?? null,
    // One value per window (the status after that window).
    compressMsPerFrame: summarize([
      ...new Map(
        timeline.flatMap((s) =>
          s.compress?.windows > 0 ? [[s.compress.windows, s.compress.msPerFrame]] : [],
        ),
      ).values(),
    ]),
    check: last?.compress?.check ?? null,
  };
}

async function liveRun(browser) {
  const sim = spawn(
    process.execPath,
    [
      join(here, 'live-sim.mjs'),
      folder,
      '--port',
      String(port),
      ...(fps ? ['--fps', fps] : []),
      ...(frames ? ['--frames', frames] : []),
    ],
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
    await page.goto(`${url}/?live=ws://localhost:${port}&debug${query ? `&${query}` : ''}`);
    await until(page, () => window.__cala?.pipeline.status() === 'running', 30_000, 'the live run');
    console.log('live run started');
    // One sample a second until the run is over (Extract too with ?factors).
    const timeline = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        timeline.push({ t: (Date.now() - t0) / 1000, ...(await page.evaluate(sample)) });
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    await until(
      page,
      () => ['done', 'error'].includes(window.__cala.pipeline.status()),
      180 * 60_000,
      'the end of the stream',
    );
    console.log('stream ended; waiting for the final library');
    await until(
      page,
      () =>
        (window.__cala.cells.status()?.final ?? false) ||
        window.__cala.pipeline.status() === 'error',
      factorRun ? 60 * 60_000 : 60_000,
      'the final library',
    );
    if (factorRun) {
      console.log('final library out; waiting for Extract on the factors');
      await until(
        page,
        () => ['done', 'error', 'cancelled'].includes(window.__cala.pass2.status()),
        60 * 60_000,
        'Extract',
      );
    }
    sampling = false;
    await sampler;
    timeline.push({ t: (Date.now() - t0) / 1000, ...(await page.evaluate(sample)) });
    const seconds = (Date.now() - t0) / 1000;
    const raw = await page.evaluate(() => {
      const c = window.__cala;
      return {
        pipeline: (0, eval)(`(${window.__pipelineMetrics})`)(),
        error: c.pipeline.error(),
        livePoints: c.pipeline.livePoints(),
        live: c.pipeline.live(),
      };
    });
    const lp = raw.livePoints;
    const t00 = lp[0]?.t ?? 0;
    // The processing walk starts behind by the warm-up frames; when did it catch up?
    const caughtUp = lp.findIndex((p) => p.lagFrames <= 8);
    const steady = caughtUp >= 0 ? lp.slice(caughtUp) : [];
    const metrics = {
      mode: 'live',
      seconds,
      error: raw.error,
      received: raw.live.received,
      missedAtSource: raw.live.missed,
      droppedByQueue: raw.live.dropped,
      processed: raw.pipeline.processed,
      slowForwarded: raw.pipeline.forwarded,
      slowDropped: raw.pipeline.slowDropped,
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
      slowLagFrames: summarize(raw.pipeline.slowLag),
      lagOverTime: lp.map((p) => ({
        t: Math.round((p.t - t00) / 100) / 10,
        frame: p.frame,
        lagFrames: p.lagFrames,
        lagMs: Math.round(p.lagMs),
        queued: p.queued,
      })),
      pipeline: { ...raw.pipeline, slowLag: undefined, fastMs: summarize(raw.pipeline.fastMs) },
      libraries: raw.pipeline.libraries,
      query,
      factors: factorSummary(timeline, raw.pipeline.processed, fps ? Number(fps) : 20),
      timeline,
      simLog,
    };
    writeFileSync(join(out, `${tag}_metrics.json`), JSON.stringify(metrics, null, 1));
    if (raw.pipeline.cells > 0) {
      await until(
        page,
        () => !document.querySelector('[data-testid=export-npz]')?.disabled,
        60_000,
        'the live export',
      );
      await exportNpz(page, join(out, `${tag}_cala.npz`));
    }
    await page.close();
    return metrics;
  } finally {
    sim.kill();
  }
}

async function fileRun(browser) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${url}/?debug${query ? `&${query}` : ''}`);
  // What the origin may store at the start (the compress pool's cap reads the same).
  const storage = await page.evaluate(() => navigator.storage.estimate()).catch(() => null);
  await page.setInputFiles('[data-testid=folder-input]', folder);
  const t0 = Date.now();
  // One sample a second until Extract is over (the factor summary reads it).
  const timeline = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        timeline.push({ t: (Date.now() - t0) / 1000, ...(await page.evaluate(sample)) });
      } catch {
        // the page is not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  await until(page, () => window.__cala?.pipeline.status() === 'running', 60_000, 'the file run');
  console.log('file run started');
  await until(page, () => window.__cala.pipeline.status() === 'done', 180 * 60_000, 'pass 1');
  const pass1Seconds = (Date.now() - t0) / 1000;
  console.log('pass 1 done; waiting for pass 2');
  await until(
    page,
    () => ['done', 'error'].includes(window.__cala.pass2.status()),
    60 * 60_000,
    'pass 2',
  );
  sampling = false;
  await sampler;
  timeline.push({ t: (Date.now() - t0) / 1000, ...(await page.evaluate(sample)) });
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
    query,
    storage: storage && { quota: storage.quota ?? null, usage: storage.usage ?? null },
    pass1Seconds,
    processed: raw.pipeline.processed,
    slowForwarded: raw.pipeline.forwarded,
    slowDropped: raw.pipeline.slowDropped,
    slowLagFrames: summarize(raw.pipeline.slowLag),
    pass2: raw.pass2,
    pipeline: { ...raw.pipeline, slowLag: undefined, fastMs: summarize(raw.pipeline.fastMs) },
    libraries: raw.pipeline.libraries,
    factors: fileFactorSummary(timeline),
    timeline,
  };
  const name = tag === 'live' ? 'file' : tag;
  writeFileSync(join(out, `${name}_metrics.json`), JSON.stringify(metrics, null, 1));
  if (raw.pass2.status === 'done') await exportNpz(page, join(out, `${name}_cala.npz`));
  await page.close();
  return metrics;
}

const launch = {
  headless: !headed,
  ...(channel ? { channel } : {}),
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist'],
};
if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
const browser = userDataDir
  ? await chromium.launchPersistentContext(userDataDir, { ...launch, acceptDownloads: true })
  : await chromium.launch(launch);
try {
  const context = userDataDir ? browser : await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(`window.__pipelineMetrics = ${pipelineMetrics.toString()};`);
  // No save dialog in a headless run: the export falls back to a download.
  await context.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  if (mode === 'live' || mode === 'both') {
    const m = await liveRun(context);
    console.log(
      `live: received ${m.received}, processed ${m.processed}, dropped ${m.droppedByQueue} (queue) + ${m.missedAtSource} (source); ` +
        `fast lag starts ${m.catchUp.startLagFrames} frames behind, caught up after ${m.catchUp.seconds?.toFixed(1)} s, ` +
        `then p99 ${m.steadyFastLagFrames.p99} frames / ${m.steadyFastLagMs.p99.toFixed(0)} ms; ` +
        `slow lag mean ${m.slowLagFrames.mean.toFixed(1)} / max ${m.slowLagFrames.max}; ${m.pipeline.cells} cells`,
    );
  }
  if (mode === 'file' || mode === 'both') {
    const m = await fileRun(context);
    console.log(
      `file: pass 1 ${m.processed} frames in ${m.pass1Seconds.toFixed(0)} s; pass 2 ${m.pass2.status} ` +
        `(${m.pass2.frames} frames x ${m.pass2.cells} cells in ${m.pass2.seconds?.toFixed(1)} s); slow lag mean ${m.slowLagFrames.mean.toFixed(1)}`,
    );
  }
} finally {
  await browser.close();
}
