#!/usr/bin/env node
/**
 * Memory breakdown of a cala run over time, per thread (local only: needs a
 * served build of the app and a recording on disk).
 *
 *   node apps/cala/scripts/memory-measure.mjs --url http://localhost:5195/ --data <folder>
 *        --out <dir> [--keep name1,name2] [--tag x] [--mode joint|separate]
 *        [--refine-runs 1] [--every 10] [--max-min 90] [--cdp 9335]
 *
 * Opens `<folder>` (a session folder or a parent of several) through the
 * folder input with `?debug`, keeps the sessions whose names contain one of
 * `--keep`, starts the run (Discover, Refine, Extract, export) and samples
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
const refineRuns = opt('--refine-runs', '1');
const mode = opt('--mode', 'joint');
const every = Number(opt('--every', '10')) * 1000;
const maxMin = Number(opt('--max-min', '90'));
const cdpPort = Number(opt('--cdp', '9335'));
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
  headless: true,
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
        refine: c.refine.status(),
        rp: c.refine.processed?.() ?? 0,
        rfps: c.refine.fps?.() ?? 0,
        extract: c.pass2.status(),
        cells: c.cells.library?.()?.ids.length ?? 0,
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
  return (
    `${r.t.toFixed(0)}s ${st.pst} ${st.pp} fps${(st.fps ?? 0).toFixed(0)} ref ${st.refine} ${st.rp} ext ${st.extract} cells ${st.cells} | ` +
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
await page.goto(`${url}?debug`);
await attachPage();
await page.setInputFiles('[data-testid=folder-input]', data);
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
if (await page.locator('[data-testid=refine-runs]').count())
  await page.selectOption('[data-testid=refine-runs]', refineRuns);
await page.waitForFunction(
  () => !document.querySelector('[data-testid=sessions-start]').disabled,
  null,
  { timeout: 120000 },
);
L('pre-start ' + fmt(await sample(true)));
await page.click('[data-testid=sessions-start]');
t0 = Date.now();
const samples = [];
let stop = null;
let lastKey = '';
while (!stop) {
  await page.waitForTimeout(every);
  const r = await sample(false);
  samples.push(r);
  L(fmt(r));
  if (r.rendererFoot > 6000 || r.rendererRss > 6000) stop = 'cap';
  const key = `${r.st?.pst}|${r.st?.refine}|${r.st?.extract}`;
  if (key !== lastKey) lastKey = key;
  const run = r.st?.run ?? '';
  if (downloads > 0 && /done|finished|complete|saved/i.test(run)) stop = 'done';
  if (/error|failed/i.test(run)) stop = 'error: ' + run;
  if (r.t > maxMin * 60) stop = 'time';
}
L('STOP ' + stop);
await page.waitForTimeout(5000);
const end = await sample(true);
samples.push({ ...end, gc: true });
L('end(gc) ' + fmt(end));
writeFileSync(join(out, `${tag}.json`), JSON.stringify(samples));
if (process.env.HOLD) await page.waitForTimeout(+process.env.HOLD * 1000);
ws.close();
await ctx.close();
rmSync(udd, { recursive: true, force: true });
