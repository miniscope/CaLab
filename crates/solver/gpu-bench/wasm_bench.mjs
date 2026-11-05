// WASM timing of the shipped CaDecon trace solve (indeca_solve_trace), the
// call cadecon-worker.ts makes, in Node: single thread, and a pool of N
// worker_threads over one iteration's subset jobs (the 25 % geometry of
// subset-store.ts with K = 8). Usage:
//   node wasm_bench.mjs <npy> <mode: single|pool|fin> [threads] [jobs-limit | fin cells]
import { readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..', 'pkg');

async function loadWasm() {
  const mod = await import(path.join(pkg, 'calab_solver.js'));
  mod.initSync({ module: readFileSync(path.join(pkg, 'calab_solver_bg.wasm')) });
  return mod;
}

function loadNpy(file) {
  const b = readFileSync(file);
  const hlen = b.readUInt16LE(8);
  const header = b.subarray(10, 10 + hlen).toString();
  const dims = header.match(/'shape': \((\d+), (\d+)\)/).slice(1).map(Number);
  const data = new Float32Array(b.buffer.slice(b.byteOffset + 10 + hlen, b.byteOffset + b.length));
  return { data, nCells: dims[0], T: dims[1] };
}

function subsetJobs(nCells, T, K = 8, coverage = 0.25) {
  const scale = Math.sqrt(coverage / K);
  const tSub = Math.floor(T * scale);
  const nSub = Math.floor(nCells * scale);
  const cols = Math.max(1, Math.floor(T / tSub));
  const rows = Math.max(1, Math.floor(nCells / nSub));
  const jobs = [];
  for (let s = 0; s < K; s++) {
    const t0 = ((s * 3) % cols) * Math.floor(T / cols);
    const c0 = (s % rows) * Math.floor(nCells / rows);
    for (let c = c0; c < c0 + nSub; c++) jobs.push([c, t0, Math.min(T, t0 + tSub)]);
  }
  return jobs;
}

function solve(w, trace) {
  return w.indeca_solve_trace(trace, 0.1, 0.6, 30, 10, 500, 1e-4, true, true, new Float32Array(0), 0, true);
}

if (isMainThread) {
  const [file, mode = 'single', threadsArg = '8', limitArg] = process.argv.slice(2);
  const { data, nCells, T } = loadNpy(file);
  if (mode === 'single') {
    const w = await loadWasm();
    const out = {};
    for (const [label, len, n] of [
      ['subset', Math.floor(T * Math.sqrt(0.25 / 8)), 16],
      ['full', T, 2],
    ]) {
      const t0 = performance.now();
      let iters = 0;
      for (let c = 0; c < n; c++) {
        const tr = data.slice(c * T, c * T + len);
        iters += solve(w, tr).iterations;
      }
      const ms = (performance.now() - t0) / n;
      out[label] = { len, n, msPerTrace: ms, itersPerTrace: iters / n };
    }
    console.log(JSON.stringify({ mode, ...out }));
  } else {
    // mode 'fin': full-length traces (the finalization pass), evenly spaced cells.
    let jobs =
      mode === 'fin'
        ? Array.from({ length: Number(limitArg ?? 32) }, (_, i) => [
            Math.floor((i * nCells) / Number(limitArg ?? 32)),
            0,
            T,
          ])
        : subsetJobs(nCells, T);
    if (limitArg && mode !== 'fin') jobs = jobs.slice(0, Number(limitArg));
    const threads = Number(threadsArg);
    const t0 = performance.now();
    const shared = new SharedArrayBuffer(4);
    const counter = new Int32Array(shared);
    const results = await Promise.all(
      Array.from({ length: threads }, () =>
        new Promise((res, rej) => {
          const wk = new Worker(fileURLToPath(import.meta.url), {
            workerData: { file, jobs, shared, T },
          });
          wk.on('message', res);
          wk.on('error', rej);
        }),
      ),
    );
    const wall = (performance.now() - t0) / 1000;
    const busy = results.reduce((a, r) => a + r.busy, 0) / 1000;
    const done = results.reduce((a, r) => a + r.done, 0);
    console.log(JSON.stringify({ mode, threads, jobs: jobs.length, done, wallS: wall, busyS: busy }));
  }
} else {
  const { file, jobs, shared, T } = workerData;
  const counter = new Int32Array(shared);
  const { data } = loadNpy(file);
  const w = await loadWasm();
  let busy = 0;
  let done = 0;
  for (;;) {
    const j = Atomics.add(counter, 0, 1);
    if (j >= jobs.length) break;
    const [c, a, b] = jobs[j];
    const tr = data.slice(c * T + a, c * T + b);
    // The 1000x54000 file has 7 cells with NaN runs (the app's NaN handling
    // test cells); the WASM entry rejects them, so skip.
    if (!tr.every(Number.isFinite)) continue;
    const t0 = performance.now();
    solve(w, tr);
    busy += performance.now() - t0;
    done++;
  }
  parentPort.postMessage({ busy, done });
}
