#!/usr/bin/env node
/**
 * Memory breakdown of a cala run over time, per thread (local only: needs a
 * served build of the app and a recording on disk).
 *
 *   node apps/cala/scripts/memory-measure.mjs --url http://localhost:5195/ --data <folder>
 *        --out <dir> [--keep name1,name2] [--tag x] [--mode joint|separate]
 *        [--every 10] [--max-min 90] [--cdp 9335] [--headed] [--single]
 *        [--lookback [--toggle] [--csettle-yield N] [--csrate R] [--csettle-off]
 *        [--pacefps F] [--pace-after S:N] [--lbpool S] [--needfirst]] [--extract]
 *   `--query '&a=b'`: extra URL parameters (e.g. `--query '&visitrate=off'`, the visit rate off).
 *   `--single`: one recording folder (Discover only, no export; `--discover-only`: stop after Discover).
 *   `--smooth 0`: smooth playback off (the comparison run). Every run saves the displayed-frame times
 *   and a once-a-second processing readout as `<tag>-display.json`.
 *   Look-back (with its Final settle) is the app's default now and there is no Refine stage, so a run
 *   opens with `?lookback=0` unless `--lookback` is given: plain `--single` measures plain Discover.
 *   `--lookback` (with `--single`): leaves look-back on, and stops once Discover has
 *   settled (the final library); it samples the look-back counters
 *   (`__cala.lookback()`) and fails unless frames were re-read and the
 *   settle pass fed its whole plan (or was stopped). `--toggle`: instead of leaving it on from the start, open with
 *   `?lookback=0`, tick the look-back checkbox once Discover runs and restart it. `--extract`:
 *   then press Extract once and wait for it.
 *   Background settle (settle during Discover) is on by default under look-back and runs only
 *   below Max; `--csettle` adds a bare `&csettle`, which changes nothing now (kept so old
 *   command lines run). `--csettle-yield N` (`&csettle=yieldN`): answers fed N frames at a
 *   time; `--csrate R`: the cap. Every look-back run also logs exact
 *   times (an in-page probe every 100 ms: last frame, settled, the longest
 *   stretch without a new frame, every settle checkpoint), the frames
 *   dropped for the slow loop, and how far the end settle moved the library
 *   Discover ended with; both libraries are written as `<tag>-live.json` and
 *   `<tag>-final.json`.
 *   `--pace-after S:N`: set the target to N fps (0 = Max) once Discover has run S seconds; logs
 *   `POOL_JOINED` with the seconds from that change to the first `settleWorkers` >= 1 and the
 *   frames dropped for the slow loop by then (total, and since the change).
 *   `--finish-after S`: press "End Discover" once Discover has run S seconds (a short run: the end
 *   settle then covers the frames read so far). `--stop-settle-after S`: press "Stop Final
 *   settle" once the settle has run S seconds; `--restart-after-settle S`: once settled, start
 *   Discover again and log look-back after S seconds (smoke tests). Every run also records the work readout
 *   (`__cala.pipeline.work()`, once a second) as `<tag>-work.json` and logs the `?debug` text
 *   readout at each sample.
 *   Background settle (the settle governor) runs by default in a look-back run below Max
 *   (`--pacefps`), with the settle pool from the core count; the governor's state is kept with
 *   each work reading and logged. `--lbpool S` overrides the pool size (`?debug&lbpool=S`, 0
 *   included); `--needfirst`: one worker, need-driven look-back first (`?debug&needfirst`);
 *   `--csettle-off`: no Background settle (`&csettle=0`).
 *   `--headed` runs system Chrome with a real GPU (headless SwiftShader hides memory behaviour).
 *   `--profile-slow d20:10,s5:10` (measurement): CPU profiles of the slow worker, each
 *   `d<start>:<len>` seconds after Discover started or `s<start>:<len>` seconds after its last
 *   frame (the Final settle), written as `<tag>-slow-<spec>.cpuprofile` (sampling every
 *   `--profile-us` µs, default 500). Run it apart from timed runs: profiling costs time.
 *   `--profile-lookback`: the look-back workers too, in the same windows (`<tag>-lb<k>-<spec>`).
 *
 * Opens `<folder>` (a session folder or a parent of several) through the
 * folder input with `?debug`, keeps the sessions whose names contain one of
 * `--keep`, starts the run (Discover, Extract, export) and samples
 * every `--every` seconds: the renderer's RSS and macOS physical footprint
 * (`footprint`), the GPU process, and per thread (main and every worker,
 * attached over raw CDP) the JS heap, the ArrayBuffer backing stores and the
 * WASM heap (`globalThis.__calaWasmHeapBytes`). After the run it forces a GC
 * and samples once more. Writes `<tag>.json` (all samples), `<tag>.log` and
 * the results zip (the save dialog is removed, so the export is a download
 * into `--out`: nothing is ever written into the data folder).
 */
import { chromium } from '@playwright/test';

/* global window, document */ // the page.evaluate callbacks run in the browser
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i < 0 ? d : args[i + 1];
};
const url = opt('--url', 'http://localhost:5195/');
const data = opt('--data');
if (!data || !opt('--out')) throw new Error('--data and --out are required');
const keep = (opt('--keep', '') || '').split(',').filter(Boolean);
const out = opt('--out');
const tag = opt('--tag', 'run');
const mode = opt('--mode', 'joint');
const every = Number(opt('--every', '10')) * 1000;
const maxMin = Number(opt('--max-min', '90'));
const cdpPort = Number(opt('--cdp', '9335'));
const lookback = args.includes('--lookback');
const extract = args.includes('--extract');
const toggle = args.includes('--toggle');
const csettle = args.includes('--csettle');
const csYield = opt('--csettle-yield', '');
const csRate = opt('--csrate', '');
const paceFps = opt('--pacefps', '');
const finishAfter = Number(opt('--finish-after', '0'));
// `--stop-settle-after S`: press "Stop Final settle" once the settle has run S seconds (smoke tests).
const stopSettleAfter = Number(opt('--stop-settle-after', '0'));
let settleStopped = false;
// `--restart-after-settle S`: once settled, start Discover again and log look-back after S seconds.
const restartAfter = Number(opt('--restart-after-settle', '0'));
let restartAt = null;
// `--pace-after S:N`: once Discover has run S seconds, set the target to N fps mid-run (0 = Max).
const paceAfter = (opt('--pace-after', '') || '').split(':').map(Number);
const csQuery0 = csettle
  ? `&csettle${csYield ? `=yield${csYield}` : ''}${csRate ? `&csrate=${csRate}` : ''}`
  : '';
// `--pacefps N`: read the recording no faster than N frames a second (a stream's rate).
// `--smooth 0`: smooth playback off (the comparison run).
const smoothOpt = opt('--smooth', '');
const lbPool = opt('--lbpool', '');
// `--query '&a=b'`: extra URL parameters as given (e.g. `&visitrate=off`).
const extraQuery = opt('--query', '');
const csQuery =
  extraQuery +
  csQuery0 +
  (paceFps ? `&pacefps=${paceFps}` : '') +
  (smoothOpt ? `&smooth=${smoothOpt}` : '') +
  (lbPool !== '' ? `&lbpool=${lbPool}` : '') +
  (args.includes('--needfirst') ? '&needfirst' : '') +
  (args.includes('--csettle-off') ? '&csettle=0' : '');
mkdirSync(out, { recursive: true });
const udd = join(out, `udd-${tag}`);
rmSync(udd, { recursive: true, force: true });
const logFile = join(out, `${tag}.log`);
writeFileSync(logFile, '');
const L = (s) => {
  console.log(s);
  appendFileSync(logFile, s + '\n');
};

const ctx = await chromium.launchPersistentContext(udd, {
  headless: !args.includes('--headed'),
  ...(args.includes('--headed') ? { channel: 'chrome' } : {}),
  args: [
    '--enable-precise-memory-info',
    '--enable-unsafe-webgpu',
    `--remote-debugging-port=${cdpPort}`,
    `--memtag=${tag}`,
  ],
  acceptDownloads: true,
  viewport: { width: 1600, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => L(`[pageerror] ${e.message}`));
page.on('crash', () => L('[PAGE CRASH]'));
page.on('response', (r) => {
  if (r.status() >= 400) L(`[http ${r.status()}] ${r.url().slice(0, 200)}`);
});
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    L(`[console.${m.type()}] ${m.text().slice(0, 300)}`);
});
let downloads = 0;
page.on('download', async (d) => {
  const p = join(out, `${tag}-${d.suggestedFilename()}`);
  await d.saveAs(p);
  downloads++;
  L(`download ${p}`);
});
await page.addInitScript(() => {
  // The Speed block saves its target and cap in the browser and applies them at page load: a
  // measurement run takes its speed from the URL (`--pacefps`, `--csrate`) only.
  try {
    localStorage.removeItem('cala.speed.v1');
  } catch {
    // No storage: nothing to clear.
  }
  delete window.showDirectoryPicker;
  delete window.showSaveFilePicker;
});

// ---- raw CDP: per-target heap usage and wasm heap ----
const ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let nextId = 1;
const pending = new Map();
const workers = new Map(); // sessionId -> url
let pageSession = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  } else if (m.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = m.params;
    if (targetInfo.type === 'worker') {
      workers.set(sessionId, targetInfo.url.split('/').pop().split('?')[0]);
      // keep the worker running (auto-attach pauses only with waitForDebuggerOnStart)
      send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  } else if (m.method === 'Target.detachedFromTarget') {
    workers.delete(m.params.sessionId);
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error('timeout ' + method));
      }
    }, 20000);
  });
}
async function attachPage() {
  const { targetInfos } = await send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'page' && x.url.startsWith(url));
  if (!t) throw new Error('no page target');
  const { sessionId } = await send('Target.attachToTarget', {
    targetId: t.targetId,
    flatten: true,
  });
  pageSession = sessionId;
  await send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    sessionId,
  );
}

const procs = () => {
  const rows = execSync('ps -axo pid=,ppid=,rss=,command=', { maxBuffer: 1e8 })
    .toString()
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3] / 1024, cmd: m[4] }));
  const root = rows.find((r) => r.cmd.includes(`--memtag=${tag}`) && !r.cmd.includes('--type='));
  if (!root) return [];
  const set = new Set([root.pid]);
  let ch = true;
  while (ch) {
    ch = false;
    for (const r of rows) {
      if (!set.has(r.pid) && set.has(r.ppid)) {
        set.add(r.pid);
        ch = true;
      }
    }
  }
  return rows
    .filter((r) => set.has(r.pid))
    .map((r) => ({
      pid: r.pid,
      rss: r.rss,
      type: r.cmd.match(/--type=(\S+)/)?.[1] ?? 'browser',
    }));
};
const footprintMB = (pid) => {
  try {
    const s = execFileSync('footprint', ['-p', String(pid), '-f', 'bytes'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const m = s.match(/Footprint:\s+([\d,]+)\s*B/) || s.match(/phys_footprint:\s+([\d,]+)/);
    return m ? +m[1].replace(/,/g, '') / 1048576 : null;
  } catch {
    return null;
  }
};

async function targetMem(sessionId) {
  const h = await send('Runtime.getHeapUsage', {}, sessionId).catch(() => null);
  const w = await send(
    'Runtime.evaluate',
    {
      expression: 'globalThis.__calaWasmHeapBytes ? globalThis.__calaWasmHeapBytes() : 0',
      returnByValue: true,
    },
    sessionId,
  ).catch(() => null);
  return {
    jsUsed: h ? h.usedSize / 1048576 : null,
    jsTotal: h ? h.totalSize / 1048576 : null,
    backing: h && h.backingStorageSize !== undefined ? h.backingStorageSize / 1048576 : null,
    embedder: h && h.embedderHeapUsedSize !== undefined ? h.embedderHeapUsedSize / 1048576 : null,
    wasm: w?.result?.value ? w.result.value / 1048576 : 0,
  };
}

async function sample(gc = false) {
  if (gc) {
    for (const s of [pageSession, ...workers.keys()])
      await send('HeapProfiler.collectGarbage', {}, s).catch(() => {});
  }
  const main = await targetMem(pageSession);
  const ws_ = [];
  for (const [s, u] of workers) ws_.push({ url: u, ...(await targetMem(s)) });
  const ps = procs();
  const rend = ps.filter((p) => p.type === 'renderer');
  const gpu = ps.filter((p) => p.type === 'gpu-process');
  const st = await page
    .evaluate(() => {
      const c = window.__cala;
      if (!c) return null;
      return {
        pst: c.pipeline.status(),
        pp: c.pipeline.processed(),
        fps: c.pipeline.fps?.() ?? 0,
        extract: c.pass2.status(),
        cells: c.cells.library?.()?.ids.length ?? 0,
        final: c.cells.status?.()?.final ?? false,
        lb: c.lookback?.() ?? null,
        batch: (() => {
          const b = c.cells.batch?.();
          return b ? { fwd: b.forwardedFrames, drop: b.droppedFrames } : null;
        })(),
        slow: (() => {
          const s = c.cells.status?.();
          return s
            ? {
                observed: s.observed,
                skipped: s.skipped,
                jobs: s.jobs,
                visitMs: s.visitMs,
                refines: s.counters?.refines ?? 0,
                visits: s.counters?.visits ?? 0,
                adds: s.counters?.adds ?? 0,
              }
            : null;
        })(),
        run: document.querySelector('[data-testid=session-run-status]')?.textContent ?? '',
      };
    })
    .catch(() => null);
  return {
    t: (Date.now() - t0) / 1000,
    st,
    rendererRss: rend.reduce((a, p) => a + p.rss, 0),
    rendererFoot: rend.map((p) => footprintMB(p.pid)).reduce((a, b) => a + (b ?? 0), 0),
    gpuRss: gpu.reduce((a, p) => a + p.rss, 0),
    gpuFoot: gpu.map((p) => footprintMB(p.pid)).reduce((a, b) => a + (b ?? 0), 0),
    totalRss: ps.reduce((a, p) => a + p.rss, 0),
    main,
    workers: ws_,
  };
}
const fmt = (r) => {
  const w = r.workers;
  const sum = (k) => w.reduce((a, x) => a + (x[k] ?? 0), 0);
  const st = r.st || {};
  const lb = st.lb
    ? ` lb pushed ${st.lb.pushed} need ${st.lb.inNeed} births ${st.lb.births}${st.lb.settling ? ' settling' : ''}${st.lb.settle ? ` settle ${st.lb.settle.fed}/${st.lb.settle.total}${st.lb.settle.moving ? ` moving ${st.lb.settle.moving.above}/${st.lb.settle.moving.cells}` : ''}` : ''}${st.lb.error ? ` ERR ${st.lb.error}` : ''}${st.final ? ' final' : ''}`
    : '';
  const cs = st.lb?.csettle
    ? ` cs ${st.lb.csettle.fit}+${st.lb.csettle.heldOut}+${st.lb.csettle.dropped}/${st.lb.csettle.requested} live ${st.lb.csettle.live} ans ${st.lb.csettle.answers} ${(st.lb.csettle.answerMs / Math.max(1, st.lb.csettle.answers)).toFixed(1)}ms max ${st.lb.csettle.maxBlockMs.toFixed(0)}ms${st.lb.csettle.governor ? ` gov ${st.lb.csettle.governor.rate.toFixed(0)}/s ${st.lb.csettle.governor.limit} halv ${st.lb.csettle.governor.halvings}(${st.lb.csettle.governor.slowHalvings})` : ''}`
    : '';
  const drop = st.batch ? ` drop ${st.batch.drop}/${st.batch.drop + st.batch.fwd}` : '';
  const slow = st.slow ? ` jobs ${st.slow.jobs} refines ${st.slow.refines}` : '';
  return (
    `${r.t.toFixed(0)}s ${st.pst}${lb}${cs}${drop}${slow} ${st.pp} fps${(st.fps ?? 0).toFixed(0)} ext ${st.extract} cells ${st.cells} | ` +
    `rend rss ${r.rendererRss.toFixed(0)} foot ${r.rendererFoot.toFixed(0)} gpu ${r.gpuFoot.toFixed(0)} | ` +
    `main js ${r.main.jsUsed?.toFixed(0)} buf ${r.main.backing?.toFixed(0)} wasm ${r.main.wasm.toFixed(0)} | ` +
    `workers(${w.length}) js ${sum('jsUsed').toFixed(0)} buf ${sum('backing').toFixed(0)} wasm ${sum('wasm').toFixed(0)} :: ` +
    w
      .map(
        (x) =>
          `${x.url.replace('-worker.ts', '').replace('.ts', '')}:${x.wasm.toFixed(0)}/${x.jsUsed?.toFixed(0)}/${x.backing?.toFixed(0)}`,
      )
      .join(' ')
  );
};

let t0 = Date.now();
await page.goto(`${url}?debug${lookback && !toggle ? '' : '&lookback=0'}${csQuery}`);
await attachPage();

// ---- `--profile-slow`: CPU profiles of the slow worker (measurement only) ----
const profileSpecs = (opt('--profile-slow', '') || '')
  .split(',')
  .filter(Boolean)
  .map((x) => {
    const m = x.match(/^([ds])(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`--profile-slow: bad spec ${x}`);
    return { spec: x, base: m[1], at: Number(m[2]) * 1000, len: Number(m[3]) * 1000, done: false };
  });
const profileUs = Number(opt('--profile-us', '500'));
function slowSession() {
  for (const [sid, u] of workers) if (u.startsWith('slow-worker')) return sid;
  return null;
}
// `--profile-lookback`: the look-back workers are profiled in the same windows (`<tag>-lb<k>-<spec>`,
// k in attach order: 0 is look-back worker 0, which the page starts first; pool workers follow).
const profileLb = args.includes('--profile-lookback');
function lookbackSessions() {
  const out = [];
  for (const [sid, u] of workers) if (u.startsWith('lookback-worker')) out.push(sid);
  return out;
}
async function profileOnce(p) {
  const sid = slowSession();
  if (!sid) {
    L(`PROFILE ${p.spec}: no slow worker target`);
    return;
  }
  const targets = [{ sid, name: 'slow' }];
  if (profileLb) lookbackSessions().forEach((s, k) => targets.push({ sid: s, name: `lb${k}` }));
  for (const t of targets) {
    await send('Profiler.enable', {}, t.sid);
    await send('Profiler.setSamplingInterval', { interval: profileUs }, t.sid);
  }
  await Promise.all(targets.map((t) => send('Profiler.start', {}, t.sid)));
  L(`PROFILE ${p.spec}: start (${targets.map((t) => t.name).join(', ')})`);
  await new Promise((r) => setTimeout(r, p.len));
  for (const t of targets) {
    const { profile } = await send('Profiler.stop', {}, t.sid);
    writeFileSync(
      join(out, `${tag}-${t.name}-${p.spec.replace(':', '_')}.cpuprofile`),
      JSON.stringify(profile),
    );
    L(`PROFILE ${p.spec} ${t.name}: ${profile.samples?.length ?? 0} samples written`);
  }
}
if (profileSpecs.length) {
  (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      const pr = await page.evaluate(() => window.__calaProbe).catch(() => null);
      if (!pr || pr.t0 === null) continue;
      const now = await page.evaluate(() => performance.now()).catch(() => null);
      if (now === null) continue;
      for (const p of profileSpecs) {
        if (p.done) continue;
        const base = p.base === 'd' ? pr.t0 : pr.framesDone;
        if (base === null || now - base < p.at) continue;
        p.done = true;
        await profileOnce(p).catch((e) => L(`PROFILE ${p.spec}: ${e.message}`));
      }
      if (profileSpecs.every((p) => p.done)) break;
    }
  })();
}
// Exact times and every settle checkpoint (the 5 s samples miss them): an in-page probe.
await page.evaluate((withRelease) => {
  const p = (window.__calaProbe = {
    t0: null,
    framesDone: null,
    final: null,
    frames: 0,
    lastFrameAt: null,
    maxGapMs: 0,
    gaps250: 0,
    atFramesDone: null,
    checkpoints: [],
  });
  // Release probe (smooth pacing): when each batch's frames arrive on the main thread, polled
  // every 5 ms. The gate releases a batch one pipeline latency earlier, so this adds the
  // pipeline's own jitter to the true spread: a ceiling for the release evenness.
  const rel = withRelease ? (window.__calaRelease = { t: [], n: [] }) : null;
  let relLast = 0;
  if (withRelease)
    setInterval(() => {
      const c = window.__cala;
      if (!c || c.pipeline.status() !== 'running') return;
      const n = c.pipeline.processed();
      if (n < relLast) {
        rel.t = [];
        rel.n = [];
      }
      if (n !== relLast) {
        rel.t.push(performance.now());
        rel.n.push(n);
      }
      relLast = n;
    }, 5);
  // Who is doing what (`__cala.pipeline.work()`): one reading a second, plain data.
  const work = (window.__calaWork = []);
  setInterval(() => {
    const c = window.__cala;
    const w = c?.pipeline.work?.();
    if (!w) return;
    const prev = work.at(-1);
    if (prev && prev.work === w) return;
    work.push({
      t: performance.now(),
      status: c.pipeline.status(),
      work: w,
      maxFps: c.pipeline.maxFps(),
      pace: c.pipeline.paceStats?.() ?? null,
      governor: c.lookback?.()?.csettle?.governor ?? null,
      settleWorkers: c.lookback?.()?.csettle?.settleWorkers ?? null,
      // The slow worker's raw cumulative accounting (with `detail` and `stage` under ?debug).
      acct: c.pipeline.accounting?.() ?? null,
      // The Final settle's status (source, workers, fed/total, waiting) and the compressor's
      // (backend, Discover's GPU waits, lag at the end), without the window list.
      settle: c.lookback?.()?.settle ?? null,
      compress: (() => {
        const cs = c.compress?.status?.();
        if (!cs) return null;
        const { compressed, ...rest } = cs;
        return { ...rest, windowsDone: compressed?.length ?? 0 };
      })(),
    });
  }, 500);
  // `--pace-after`: the first time the settle pool serves after the target change.
  setInterval(() => {
    const c = window.__cala;
    const pa = window.__calaPaceAt;
    if (pa && !window.__calaPoolJoin && (c.lookback?.()?.csettle?.settleWorkers ?? 0) >= 1) {
      const dropped = c.cells.batch?.()?.droppedFrames ?? 0;
      window.__calaPoolJoin = {
        afterS: (performance.now() - pa.t) / 1000,
        dropped,
        droppedSince: dropped - pa.dropped,
        settleDropped: c.lookback?.()?.csettle?.dropped ?? null,
      };
    }
  }, 100);
  // Display and processing (`--smooth`): once a second, frames processed, rate, dropped for the slow loop.
  const proc = (window.__calaProc = []);
  setInterval(() => {
    const c = window.__cala;
    if (!c) return;
    proc.push({
      t: performance.now(),
      status: c.pipeline.status(),
      processed: c.pipeline.processed(),
      fps: c.pipeline.fps(),
      dropped: c.cells.batch?.()?.droppedFrames ?? 0,
      playback: c.pipeline.playbackStats?.() ?? null,
    });
  }, 1000);
  let lastKey = '';
  setInterval(() => {
    const c = window.__cala;
    if (!c) return;
    const now = performance.now();
    const pst = c.pipeline.status();
    const n = c.pipeline.processed();
    if (pst === 'running') {
      if (p.t0 === null || n < p.frames) {
        // (A restart begins again.)
        p.t0 = now;
        p.lastFrameAt = now;
        p.maxGapMs = 0;
        p.gaps250 = 0;
        p.framesDone = null;
        p.final = null;
        p.checkpoints = [];
        p.heldMs = 0;
        p.minHold = null;
      } else if (n > p.frames) {
        const gap = now - p.lastFrameAt;
        if (gap > p.maxGapMs) p.maxGapMs = gap;
        if (gap > 250) p.gaps250++;
        p.lastFrameAt = now;
      }
      p.frames = n;
      // The Discover visit rate's hold (null: not held), its time and lowest value.
      const hold = c.pipeline.visitHold?.() ?? null;
      if (hold !== null) {
        p.heldMs = (p.heldMs ?? 0) + 100;
        p.minHold =
          p.minHold === null || p.minHold === undefined ? hold : Math.min(p.minHold, hold);
      }
    }
    const st = c.cells.status?.();
    const lb = st?.lookback;
    if (pst === 'done' && p.framesDone === null && p.t0 !== null) {
      p.framesDone = now;
      p.frames = n;
      const b = c.cells.batch?.();
      p.atFramesDone = {
        cells: c.cells.library?.()?.ids.length ?? 0,
        heldS: (p.heldMs ?? 0) / 1000,
        minHold: p.minHold ?? null,
        visitMode: c.pipeline.visitMode?.() ?? null,
        consumed: st?.consumed ?? null,
        visitRate: st?.visitRate ?? null,
        fwd: b?.forwardedFrames ?? 0,
        drop: b?.droppedFrames ?? 0,
        lb: lb ? JSON.parse(JSON.stringify(lb)) : null,
        slow: st
          ? {
              observed: st.observed,
              skipped: st.skipped,
              jobs: st.jobs,
              refines: st.counters.refines,
              visits: st.counters.visits,
              adds: st.counters.adds,
            }
          : null,
      };
    }
    const m = lb?.settle?.moving;
    if (m && lb.settle) {
      const key = `${lb.settle.fed}|${m.above}|${m.cells}`;
      // (The count changes only at a checkpoint; log it once.)
      const prev = p.checkpoints.at(-1);
      if (key !== lastKey && !(prev && prev.above === m.above && prev.cells === m.cells)) {
        p.checkpoints.push({ t: now, fed: lb.settle.fed, above: m.above, cells: m.cells });
      }
      lastKey = key;
    }
    if (pst === 'done' && st?.final && !lb?.settling && p.final === null && p.framesDone !== null)
      p.final = now;
  }, 100);
}, Boolean(paceFps));
const single = args.includes('--single');
await page.setInputFiles('[data-testid=folder-input]', data);
if (single) {
  // One recording folder: Discover starts by itself.
  await page.waitForFunction(() => window.__cala?.pipeline.status() === 'running', null, {
    timeout: 120000,
  });
  if (lookback && toggle) {
    // The user's path: tick the checkbox, then restart Discover from frame 0.
    L(
      'toggle: ' +
        (await page.$eval(
          '[data-testid=lookback-toggle]',
          (e) => `disabled=${e.disabled} title=${e.closest('label')?.title}`,
        )),
    );
    await page.check('[data-testid=lookback-toggle]', { timeout: 10000 });
    await page.click('button[aria-label=Restart]');
    await page.waitForFunction(() => window.__cala?.lookbackOn() === true, null, {
      timeout: 60000,
    });
    t0 = Date.now();
    L('toggle: look-back on after restart');
  }
} else {
  await page.waitForSelector('[data-testid=session-item]', { timeout: 120000 });
  await page.waitForTimeout(3000);
  if (keep.length) {
    for (;;) {
      const names = await page.$$eval('[data-testid=session-item]', (e) =>
        e.map((x) => x.textContent),
      );
      const drop = names.findIndex((n) => !keep.some((k) => n.includes(k)));
      if (drop < 0) break;
      await page.locator('[data-testid=session-remove]').nth(drop).click();
      await page.waitForTimeout(300);
    }
  }
  L(
    'sessions: ' +
      JSON.stringify(
        await page.$$eval('[data-testid=session-item]', (e) =>
          e.map((x) => x.textContent.slice(0, 80)),
        ),
      ),
  );
  if (await page.locator(`[data-testid=mode-${mode}]`).count())
    await page.check(`[data-testid=mode-${mode}]`);
  await page.waitForFunction(
    () => !document.querySelector('[data-testid=sessions-start]').disabled,
    null,
    { timeout: 120000 },
  );
  L('pre-start ' + fmt(await sample(true)));
  await page.click('[data-testid=sessions-start]');
  t0 = Date.now();
}
/** The in-page probe's times, the end settle's change and the two libraries (look-back runs). */
async function probeReport() {
  const p = await page.evaluate(() => window.__calaProbe).catch(() => null);
  if (!p || p.t0 === null) return;
  const s = (a, b) => (a !== null && b !== null ? ((a - b) / 1000).toFixed(1) : '?');
  const frames = p.frames;
  const dSec = p.framesDone !== null ? (p.framesDone - p.t0) / 1000 : NaN;
  L(
    `PROBE discover ${s(p.framesDone, p.t0)}s ${frames} frames ${(frames / dSec).toFixed(0)} fps · end settle ${s(p.final, p.framesDone)}s · total ${s(p.final, p.t0)}s · longest stretch without a new frame ${p.maxGapMs.toFixed(0)} ms (${p.gaps250} over 250 ms)`,
  );
  const rel = await page.evaluate(() => window.__calaRelease).catch(() => null);
  if (rel && rel.t.length > 3) {
    // Arrival intervals per batch (a poll that saw several batches at once is split evenly).
    const iv = [];
    for (let i = 1; i < rel.t.length; i++) {
      const batches = Math.max(1, Math.round((rel.n[i] - rel.n[i - 1]) / 8));
      for (let k = 0; k < batches; k++) iv.push((rel.t[i] - rel.t[i - 1]) / batches);
    }
    const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
    const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
    const sorted = [...iv].sort((a, b) => a - b);
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    L(
      `PROBE release intervals n=${iv.length} mean ${mean.toFixed(1)} ms (${(8000 / mean).toFixed(1)} fps) CV ${((100 * sd) / mean).toFixed(1)}% p5 ${q(0.05).toFixed(0)} p50 ${q(0.5).toFixed(0)} p95 ${q(0.95).toFixed(0)} max ${sorted[sorted.length - 1].toFixed(0)} ms`,
    );
    // The first 3 s (warm-up) are excluded from the steady-state spread.
    const t0r = rel.t[0] + 3000;
    const steady = [];
    for (let i = 1; i < rel.t.length; i++) if (rel.t[i] > t0r) steady.push(rel.t[i] - rel.t[i - 1]);
    if (steady.length > 3) {
      const m2 = steady.reduce((a, b) => a + b, 0) / steady.length;
      const sd2 = Math.sqrt(steady.reduce((a, b) => a + (b - m2) ** 2, 0) / steady.length);
      L(
        `PROBE release steady (after 3 s) n=${steady.length} mean ${m2.toFixed(1)} ms CV ${((100 * sd2) / m2).toFixed(1)}% max ${Math.max(...steady).toFixed(0)} ms`,
      );
    }
  }
  L(`PROBE at-frames-done ${JSON.stringify(p.atFramesDone)}`);
  L(
    `PROBE checkpoints ${p.checkpoints.map((c) => `${c.fed}:${c.above}/${c.cells}@${((c.t - p.framesDone) / 1000).toFixed(0)}s`).join(' ')}`,
  );
  const ch = await page.evaluate(() => window.__cala.endSettleChange?.() ?? null).catch(() => null);
  L(`PROBE end-settle-change ${JSON.stringify(ch)}`);
  const plain = (l) =>
    l && {
      version: l.version,
      frame: l.frame,
      width: l.width,
      height: l.height,
      ids: Array.from(l.ids),
      starts: Array.from(l.starts),
      pixels: Array.from(l.pixels),
      values: Array.from(l.values, (v) => Math.round(v * 1e5) / 1e5),
    };
  const libs = await page
    .evaluate(
      `(() => { const plain = ${plain.toString()}; const c = window.__cala; return { live: plain(c.discoverEnd?.()?.library), final: plain(c.cells.library()), noise: Array.from(c.cells.status()?.footprintNoise ?? []) }; })()`,
    )
    .catch((e) => (L(`PROBE libraries failed: ${e.message}`), null));
  if (libs?.live) writeFileSync(join(out, `${tag}-live.json`), JSON.stringify(libs.live));
  if (libs?.final)
    writeFileSync(
      join(out, `${tag}-final.json`),
      JSON.stringify({ ...libs.final, noise: libs.noise }),
    );
  writeFileSync(join(out, `${tag}-probe.json`), JSON.stringify({ probe: p, endSettleChange: ch }));
}

/**
 * Plain runs (Discover only): the library as it stands now, written as `<tag>-<kind>.json`
 * (`live` and `final`, both at the end of Discover), and at the end the probe's times.
 */
async function saveLibrary(kind) {
  const plain = (l) =>
    l && {
      version: l.version,
      frame: l.frame,
      width: l.width,
      height: l.height,
      ids: Array.from(l.ids),
      starts: Array.from(l.starts),
      pixels: Array.from(l.pixels),
      values: Array.from(l.values, (v) => Math.round(v * 1e5) / 1e5),
    };
  const lib = await page
    .evaluate(
      `(() => { const plain = ${plain.toString()}; const c = window.__cala; return { lib: plain(c.cells.library()), noise: Array.from(c.cells.status()?.footprintNoise ?? []) }; })()`,
    )
    .catch((e) => (L(`PROBE library ${kind} failed: ${e.message}`), null));
  if (lib?.lib)
    writeFileSync(
      join(out, `${tag}-${kind}.json`),
      JSON.stringify(kind === 'final' ? { ...lib.lib, noise: lib.noise } : lib.lib),
    );
  if (kind === 'final') {
    const p = await page.evaluate(() => window.__calaProbe).catch(() => null);
    if (p) {
      const s = (a, b) => (a !== null && b !== null ? ((a - b) / 1000).toFixed(1) : '?');
      L(
        `PROBE plain discover ${s(p.framesDone, p.t0)}s frames ${p.frames} at-frames-done ${JSON.stringify(p.atFramesDone)}`,
      );
      writeFileSync(join(out, `${tag}-probe.json`), JSON.stringify({ probe: p }));
    }
  }
}

/** The work readings of the page, saved (also when a run stops without settling). */
async function saveWork() {
  const w = await page.evaluate(() => window.__calaWork).catch(() => null);
  if (w?.length) writeFileSync(join(out, `${tag}-work.json`), JSON.stringify(w));
  const d = await page
    .evaluate(() => ({
      display: window.__cala.pipeline.displayLog?.() ?? [],
      proc: window.__calaProc ?? [],
    }))
    .catch(() => null);
  if (d?.display.length || d?.proc.length)
    writeFileSync(join(out, `${tag}-display.json`), JSON.stringify(d));
}

let finishedEarly = false;
let pacedLater = false;
let poolJoinLogged = false;
let extractClicked = false;
let discoverDoneAt = null;
let framesDoneAt = null;
const samples = [];
let stop = null;
let lastKey = '';
while (!stop) {
  await page.waitForTimeout(every);
  const r = await sample(false);
  samples.push(r);
  L(fmt(r));
  const wtxt = await page
    .evaluate(() => document.querySelector('[data-testid=work-debug]')?.textContent ?? '')
    .catch(() => '');
  if (wtxt) L(`WORK ${r.t.toFixed(0)}s\n${wtxt}`);
  if (paceAfter.length === 2 && r.st?.pst === 'running' && r.t > paceAfter[0] && !pacedLater) {
    pacedLater = true;
    L(`PACE_AFTER ${r.t.toFixed(1)}s -> ${paceAfter[1]} fps`);
    await page.evaluate((fps) => {
      window.__calaPaceAt = {
        t: performance.now(),
        dropped: window.__cala.cells.batch?.()?.droppedFrames ?? 0,
      };
      window.__cala.pipeline.setPaceFps(fps);
    }, paceAfter[1]);
  }
  if (pacedLater && !poolJoinLogged) {
    const j = await page.evaluate(() => window.__calaPoolJoin ?? null).catch(() => null);
    if (j) {
      poolJoinLogged = true;
      L(`POOL_JOINED ${JSON.stringify(j)}`);
    }
  }
  if (finishAfter > 0 && r.st?.pst === 'running' && r.t > finishAfter && !finishedEarly) {
    finishedEarly = true;
    L(`FINISH_EARLY ${r.t.toFixed(1)}s`);
    await page.evaluate(() => window.__cala.pipeline.finishEarly());
  }
  if (
    stopSettleAfter > 0 &&
    framesDoneAt !== null &&
    r.st?.lb?.settling &&
    r.t - framesDoneAt > stopSettleAfter &&
    !settleStopped
  ) {
    settleStopped = true;
    L(`STOP_SETTLE ${r.t.toFixed(1)}s ${JSON.stringify(r.st.lb.settle ?? null)}`);
    await page.click('[data-testid=lookback-stop-settling]');
  }
  if (r.rendererFoot > 6000 || r.rendererRss > 6000) stop = 'cap';
  const key = `${r.st?.pst}|${r.st?.extract}`;
  if (key !== lastKey) lastKey = key;
  const run = r.st?.run ?? '';
  if (single && lookback) {
    // Discover runs look-back alongside and settles after its last frame.
    if (r.st?.pst === 'done' && framesDoneAt === null) {
      framesDoneAt = r.t;
      L(`DISCOVER_FRAMES_DONE ${r.t.toFixed(1)}s`);
    }
    const settled = r.st?.pst === 'done' && r.st?.final && !r.st?.lb?.settling;
    if (settled && discoverDoneAt === null) {
      discoverDoneAt = r.t;
      L(`DISCOVER_SETTLED ${r.t.toFixed(1)}s ${JSON.stringify(r.st.lb)}`);
      await probeReport();
      if (extract) {
        extractClicked = true;
        await page.click('[data-testid=pass2-run]');
      } else if (restartAfter > 0) {
        // Smoke: Discover again in the same page; the look-back worker must still serve.
        restartAt = r.t;
        L(`RESTART ${r.t.toFixed(1)}s`);
        await page.evaluate(() => void window.__cala.pipeline.start());
      } else stop = 'done';
    }
    if (restartAt !== null && r.t - restartAt > restartAfter) {
      L(
        `RESTART_LB ${(r.t - restartAt).toFixed(1)}s ${r.st?.pst} ${JSON.stringify(r.st?.lb ?? null)}`,
      );
      stop = 'done';
    }
    if (extractClicked && r.st?.extract === 'done') {
      L(`EXTRACT_DONE ${r.t.toFixed(1)}s`);
      stop = 'done';
    }
    if (r.st?.pst === 'error' || r.st?.extract === 'error') stop = 'error';
  } else if (single && args.includes('--discover-only')) {
    // Discover only (with `--finish-after S` a short one): stop once it is done.
    if (r.st?.pst === 'done') {
      L(`DISCOVER_DONE ${r.t.toFixed(1)}s`);
      stop = 'done';
    }
    if (r.st?.pst === 'error') stop = 'error';
  } else if (single) {
    // Plain Discover (look-back off): stop once it is done.
    if (r.st?.pst === 'done') {
      L(`DISCOVER_DONE ${r.t.toFixed(1)}s`);
      await saveLibrary('live');
      await saveLibrary('final');
      stop = 'done';
    }
    if (r.st?.pst === 'error') stop = 'error';
  }
  if (!single && downloads > 0 && /done|finished|complete|saved/i.test(run)) stop = 'done';
  if (!single && /error|failed/i.test(run)) stop = 'error: ' + run;
  if (r.t > maxMin * 60) stop = 'time';
}
L('STOP ' + stop);
await saveWork();
const readouts = await page
  .$$eval('.cala-readout', (els) => els.map((e) => e.textContent?.trim()).filter(Boolean))
  .catch(() => []);
for (const t of readouts) L(`READOUT ${t}`);
if (lookback) {
  const lb = samples.at(-1)?.st?.lb;
  const sp = lb?.settle;
  const ok =
    stop === 'done' &&
    lb &&
    lb.pushed > 0 &&
    sp &&
    sp.done &&
    (sp.fed === sp.total || sp.stopped) &&
    !lb.error;
  L(`LOOKBACK_CHECK ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(lb)}`);
  if (!ok) process.exitCode = 1;
}
await page.waitForTimeout(5000);
const end = await sample(true);
samples.push({ ...end, gc: true });
L('end(gc) ' + fmt(end));
writeFileSync(join(out, `${tag}.json`), JSON.stringify(samples));
if (process.env.HOLD) await page.waitForTimeout(+process.env.HOLD * 1000);
ws.close();
await ctx.close();
rmSync(udd, { recursive: true, force: true });
