/**
 * Validation + benchmark harness: WASM banded solver (reference) vs the
 * batched WebGPU FISTA. Driven by gpu-tests/*.spec.ts; also usable by hand
 * with `npm run harness -w @calab/compute-gpu`.
 *
 * Results: printed to the page, logged with the prefix GPU-SPIKE-RESULT, and
 * stored on window.__gpuSpike for Playwright.
 */
import { initWasm, Solver, simulate_traces } from '@calab/core/wasm';
import {
  buildSimulationConfig,
  decodeSolverState,
  DEFAULT_QUALITATIVE_CONFIG,
  encodeSolverState,
} from '@calab/compute';
import {
  createGpuFista,
  estimateBytes,
  estimateGpuBytes,
  maxCellsPerGroup,
  maxAbsDiff,
  relL2,
  requestGpuDevice,
  type GpuFista,
  type GpuFistaParams,
} from '../src/index.ts';

declare global {
  interface Window {
    __gpuSpike?: { status: 'running' | 'done' | 'error'; result?: unknown; error?: string };
  }
}

const logEl = document.getElementById('log')!;
const lines: string[] = [];
function log(s: string): void {
  lines.push(s);
  logEl.textContent = lines.join('\n');
  console.log(s);
}
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

const CATUNE: GpuFistaParams = {
  tauRise: 0.02,
  tauDecay: 0.4,
  fs: 30,
  lambda: 0.5,
  constraint: 'nonneg',
  tol: 1e-4,
  maxIters: 5000,
  filtered: true,
};
const CADECON: GpuFistaParams = {
  tauRise: 0.02,
  tauDecay: 0.4,
  fs: 300,
  lambda: 0,
  constraint: 'box01',
  tol: 1e-4,
  maxIters: 500,
  filtered: true,
};

function simulate(nCells: number, T: number, seed: number): Float32Array[] {
  const cfg = buildSimulationConfig(DEFAULT_QUALITATIVE_CONFIG, {
    fs_hz: 30,
    num_timepoints: T,
    num_cells: nCells,
    seed,
  });
  const res = simulate_traces(cfg) as { traces: number[] };
  return Array.from({ length: nCells }, (_, c) =>
    Float32Array.from(res.traces.slice(c * T, (c + 1) * T)),
  );
}

function newSolver(p: GpuFistaParams): Solver {
  const s = new Solver();
  s.set_conv_mode(1);
  s.set_params(p.tauRise, p.tauDecay, p.lambda, p.fs);
  s.set_constraint(p.constraint === 'box01' ? 1 : 0);
  return s;
}

/** CaTune's pool-worker preprocessing: filter, rolling-baseline subtraction. */
function catuneWorkingTrace(raw: Float32Array, p: GpuFistaParams): Float32Array {
  const s = newSolver(p);
  s.set_trace(raw);
  s.set_filter_enabled(true);
  s.apply_filter();
  s.subtract_baseline();
  const w = s.get_trace();
  s.free();
  return w;
}

function upsample(x: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(x.length * factor);
  for (let i = 0; i < out.length; i++) out[i] = x[Math.floor(i / factor)];
  return out;
}

interface WasmRun {
  working: Float32Array;
  solution: Float32Array;
  iterations: number;
  converged: boolean;
  filtered: boolean;
  ms: number;
}

/**
 * Solve one trace with the WASM banded solver. `prep` = 'catune' runs the
 * CaTune preprocessing on `raw`; 'subtract' only subtract_baseline() (solver
 * marked filtered, like CaDecon's baseline_subtracted path); 'none' leaves
 * the trace as-is (baseline estimated every iteration).
 */
function wasmSolve(
  raw: Float32Array,
  p: GpuFistaParams,
  prep: 'catune' | 'subtract' | 'none',
): WasmRun {
  const s = newSolver(p);
  s.set_trace(raw);
  if (prep === 'catune') {
    s.set_filter_enabled(true);
    s.apply_filter();
  }
  if (prep !== 'none') s.subtract_baseline();
  const working = s.get_trace();
  const t0 = performance.now();
  // Never call get_reconvolution*/get_baseline between batches (they mutate state).
  while (!s.converged() && s.iteration_count() < p.maxIters) {
    s.step_batch(Math.min(50, p.maxIters - s.iteration_count()));
  }
  const ms = performance.now() - t0;
  const out = {
    working,
    solution: s.get_solution(),
    iterations: s.iteration_count(),
    converged: s.converged(),
    filtered: prep !== 'none',
    ms,
  };
  s.free();
  return out;
}

interface CaseResult {
  name: string;
  nCells: number;
  T: number;
  params: GpuFistaParams;
  perCell: {
    maxAbs: number;
    relL2: number;
    wasmIters: number;
    gpuIters: number;
    wasmConverged: boolean;
    gpuConverged: boolean;
  }[];
  worstRelL2: number;
  worstMaxAbs: number;
  worstIterRelDiff: number;
  wasmTotalMs: number;
  gpuMs: number;
}

async function equivCase(
  gpu: GpuFista,
  name: string,
  raws: Float32Array[],
  p: GpuFistaParams,
  prep: 'catune' | 'subtract' | 'none',
): Promise<CaseResult> {
  const runs: WasmRun[] = [];
  for (const raw of raws) {
    runs.push(wasmSolve(raw, p, prep));
    await nextFrame();
  }
  const T = runs[0].working.length;
  const n = runs.length;
  const traces = new Float32Array(n * T);
  runs.forEach((r, c) => traces.set(r.working, c * T));
  const gp = { ...p, filtered: runs[0].filtered };
  const t0 = performance.now();
  await gpu.load(traces, n, T, gp);
  const sol = await gpu.solve(50);
  const gpuMs = performance.now() - t0;
  const perCell = runs.map((r, c) => {
    const g = sol.solutions.subarray(c * T, (c + 1) * T);
    return {
      maxAbs: maxAbsDiff(g, r.solution),
      relL2: relL2(g, r.solution),
      wasmIters: r.iterations,
      gpuIters: sol.iterations[c],
      wasmConverged: r.converged,
      gpuConverged: sol.converged[c] === 1,
    };
  });
  gpu.destroy();
  const res: CaseResult = {
    name,
    nCells: n,
    T,
    params: gp,
    perCell,
    worstRelL2: Math.max(...perCell.map((c) => c.relL2)),
    worstMaxAbs: Math.max(...perCell.map((c) => c.maxAbs)),
    worstIterRelDiff: Math.max(
      ...perCell.map((c) => Math.abs(c.gpuIters - c.wasmIters) / Math.max(c.wasmIters, 1)),
    ),
    wasmTotalMs: runs.reduce((a, r) => a + r.ms, 0),
    gpuMs,
  };
  log(
    `\n[equiv] ${name}: N=${n} T=${T} worst relL2=${res.worstRelL2.toExponential(2)} ` +
      `worst maxAbs=${res.worstMaxAbs.toExponential(2)} worst iter diff=${(100 * res.worstIterRelDiff).toFixed(1)}% ` +
      `(wasm serial ${res.wasmTotalMs.toFixed(0)} ms, gpu ${gpuMs.toFixed(0)} ms)`,
  );
  log('  cell  relL2      maxAbs     wasmIt gpuIt conv(w/g)');
  perCell.forEach((c, i) =>
    log(
      `  ${String(i).padStart(4)}  ${c.relL2.toExponential(2).padEnd(9)}  ${c.maxAbs.toExponential(2).padEnd(9)}  ` +
        `${String(c.wasmIters).padStart(6)} ${String(c.gpuIters).padStart(5)} ${c.wasmConverged ? 'y' : 'n'}/${c.gpuConverged ? 'y' : 'n'}`,
    ),
  );
  return res;
}

interface BenchRow {
  N: number;
  T: number;
  profile: string;
  groups?: number;
  gpuMsPer200?: number;
  wasmSingleMsPer200?: number;
  wasmIdeal8WorkerMsEstimate?: number;
  speedupVsIdeal8?: number;
  skipped?: string;
}

async function bench(
  device: GPUDevice,
  gpu: GpuFista,
  pool30: Float32Array[],
): Promise<BenchRow[]> {
  const ITERS = 200;
  const rows: BenchRow[] = [];
  for (const T of [27000, 270000]) {
    const p: GpuFistaParams =
      T === 27000
        ? { ...CATUNE, tol: 0, maxIters: ITERS + 5 }
        : { ...CADECON, tol: 0, maxIters: ITERS + 5 };
    const profile = T === 27000 ? 'CaTune 30 Hz nonneg' : 'CaDecon 300 Hz box01';
    const pool = T === 27000 ? pool30 : pool30.map((x) => upsample(x, 10));

    // WASM: one cell x 200 iterations (tolerance is fixed at 1e-4 in the JS
    // API, so scale if it converges early).
    const s = newSolver(p);
    s.set_trace(pool[0]);
    s.subtract_baseline();
    s.step_batch(5);
    s.set_trace(pool[0]);
    s.subtract_baseline();
    const t0 = performance.now();
    s.step_batch(ITERS);
    const wasmMs = ((performance.now() - t0) * ITERS) / Math.max(s.iteration_count(), 1);
    s.free();
    await nextFrame();

    for (const N of [8, 64, 256, 1024]) {
      const row: BenchRow = { N, T, profile, wasmSingleMsPer200: wasmMs };
      row.wasmIdeal8WorkerMsEstimate = (wasmMs * N) / 8;
      if (maxCellsPerGroup(device, T) < 1) {
        row.skipped = 'trace exceeds device buffer limits';
      } else {
        // No harness-side cap: try it, and report a device out-of-memory or
        // validation error clearly instead of crashing the run.
        device.pushErrorScope('out-of-memory');
        device.pushErrorScope('validation');
        let failure: string | null = null;
        try {
          const traces = new Float32Array(N * T);
          for (let c = 0; c < N; c++) traces.set(pool[c % pool.length], c * T);
          await gpu.load(traces, N, T, p);
          await gpu.step(5); // warm-up
          const g0 = performance.now();
          await gpu.step(ITERS);
          row.gpuMsPer200 = performance.now() - g0;
          row.groups = gpu.groupCount;
          row.speedupVsIdeal8 = row.wasmIdeal8WorkerMsEstimate / row.gpuMsPer200;
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
        }
        const validation = await device.popErrorScope();
        const oom = await device.popErrorScope();
        if (oom)
          failure = `GPU out of memory (${(estimateGpuBytes(N, T) / 1024 ** 3).toFixed(2)} GB needed): ${oom.message}`;
        else if (validation) failure = `GPU validation error: ${validation.message}`;
        gpu.destroy();
        if (failure) {
          delete row.gpuMsPer200;
          delete row.speedupVsIdeal8;
          row.skipped = failure;
        }
      }
      rows.push(row);
      log(
        `[bench] N=${N} T=${T} ` +
          (row.skipped
            ? `skipped (${row.skipped})`
            : `gpu=${row.gpuMsPer200!.toFixed(1)} ms/200it  wasm1=${wasmMs.toFixed(1)} ms  ` +
              `wasm8-ideal(est)=${row.wasmIdeal8WorkerMsEstimate.toFixed(1)} ms  x${row.speedupVsIdeal8!.toFixed(2)}`),
      );
      await nextFrame();
    }
  }
  return rows;
}

function benchTable(rows: BenchRow[], adapter: string): string {
  const out = [
    `Adapter: ${adapter}`,
    '| N | T | profile | groups | GPU ms / 200 it | WASM 1 cell ms / 200 it | WASM 8-worker ideal ms (estimate) | GPU speedup vs ideal |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    out.push(
      r.skipped
        ? `| ${r.N} | ${r.T} | ${r.profile} | - | skipped: ${r.skipped} | ${r.wasmSingleMsPer200!.toFixed(1)} | ${r.wasmIdeal8WorkerMsEstimate!.toFixed(0)} | - |`
        : `| ${r.N} | ${r.T} | ${r.profile} | ${r.groups} | ${r.gpuMsPer200!.toFixed(1)} | ${r.wasmSingleMsPer200!.toFixed(1)} | ${r.wasmIdeal8WorkerMsEstimate!.toFixed(0)} | ${r.speedupVsIdeal8!.toFixed(2)}x |`,
    );
  }
  return out.join('\n');
}

/**
 * Cell grouping: the same 8-cell CaTune-like problem solved with one group and
 * with maxGroupBytes set so it needs >= 3 groups. Groups are independent, so
 * the results should be bitwise identical; both are also compared to WASM.
 */
async function groupingCase(
  device: GPUDevice,
  single: GpuFista,
  raws: Float32Array[],
): Promise<Record<string, unknown>> {
  const p = CATUNE;
  const runs = raws.map((raw) => wasmSolve(raw, p, 'catune'));
  const T = runs[0].working.length;
  const n = runs.length;
  const traces = new Float32Array(n * T);
  runs.forEach((r, c) => traces.set(r.working, c * T));
  const gp = { ...p, filtered: true };

  await single.load(traces, n, T, gp);
  const ref = await single.solve(50);
  const singleGroups = single.groupCount;
  single.destroy();

  const grouped = await createGpuFista(device, { maxGroupBytes: 3 * estimateGpuBytes(1, T) });
  await grouped.load(traces, n, T, gp);
  const sol = await grouped.solve(50);
  const groupCount = grouped.groupCount;
  grouped.destroy();

  // Streaming: a total budget of 4 cells (plus tables and a 2-row staging
  // buffer) for 8 cells, so groups of 2 stream with at most 2 resident.
  const stagingBytes = 2 * T * 4;
  const streamed = await createGpuFista(device, {
    maxTotalBytes: estimateBytes(4, T, stagingBytes),
    stagingBytes,
  });
  await streamed.load(traces, n, T, gp);
  const streamOut = new Float32Array(n * T);
  let peakResident = streamed.residentGroups;
  for (;;) {
    const r = await streamed.step(50);
    peakResident = Math.max(peakResident, streamed.residentGroups);
    if (r.allDone) break;
  }
  const streamSol = await streamed.readSolutions(streamOut);
  const streamGroups = streamed.groupCount;
  streamed.destroy();

  const bitEq = (a: Float32Array, b: Float32Array) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const bitwiseEqual = bitEq(ref.solutions, sol.solutions);
  const streamedBitwiseEqual =
    streamSol.solutions === streamOut &&
    bitEq(ref.solutions, streamOut) &&
    streamSol.iterations.every((it, c) => it === ref.iterations[c]);
  const perCell = runs.map((r, c) => {
    const g = sol.solutions.subarray(c * T, (c + 1) * T);
    const s1 = ref.solutions.subarray(c * T, (c + 1) * T);
    return {
      relL2VsSingle: relL2(g, s1),
      maxAbsVsSingle: maxAbsDiff(g, s1),
      itersEqualSingle: sol.iterations[c] === ref.iterations[c],
      relL2VsWasm: relL2(g, r.solution),
      wasmIters: r.iterations,
      gpuIters: sol.iterations[c],
      wasmConverged: r.converged,
      gpuConverged: sol.converged[c] === 1,
    };
  });
  const res = {
    nCells: n,
    T,
    groupCount,
    singleGroups,
    bitwiseEqual,
    streamGroups,
    peakResident,
    streamedBitwiseEqual,
    perCell,
  };
  log(
    `\n[groups] N=${n} T=${T}: grouped=${groupCount} groups, single=${singleGroups}, bitwise equal=${bitwiseEqual}; ` +
      `streamed ${streamGroups} groups, peak resident ${peakResident}, bitwise equal=${streamedBitwiseEqual}, ` +
      `worst relL2 vs single=${Math.max(...perCell.map((c) => c.relL2VsSingle)).toExponential(2)}, ` +
      `worst relL2 vs wasm=${Math.max(...perCell.map((c) => c.relL2VsWasm)).toExponential(2)}`,
  );
  return res;
}

/** FNV-1a over the bit patterns: equal hashes = (almost surely) bitwise-equal arrays. */
function bitHash(a: Float32Array): number {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0;
  return h;
}

/**
 * One full-coverage CaDecon pass: N x 270000, convergence on, up to 500
 * iterations; once fully resident, once streamed under a 1 GiB total budget.
 */
async function fullPass(
  device: GPUDevice,
  gpu: GpuFista,
  pool30: Float32Array[],
  N: number,
): Promise<Record<string, unknown>> {
  const pool = pool30.map((x) => upsample(x, 10));
  const T = pool[0].length;
  const p = CADECON; // box01, lambda 0, tol 1e-4, maxIters 500
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  const t0 = performance.now();
  const traces = new Float32Array(N * T);
  for (let c = 0; c < N; c++) traces.set(pool[c % pool.length], c * T);
  const out = new Float32Array(N * T);
  const t1 = performance.now();
  await gpu.load(traces, N, T, p);
  const sol = await gpu.solve(50, out);
  const t2 = performance.now();
  const groups = gpu.groupCount;
  gpu.destroy();
  const residentHash = bitHash(out);
  const iterations = Array.from(sol.iterations);

  const budget = 1024 ** 3;
  const streamed = await createGpuFista(device, { maxTotalBytes: budget });
  const t3 = performance.now();
  await streamed.load(traces, N, T, p);
  let peakResident = streamed.residentGroups;
  for (;;) {
    const r = await streamed.step(50);
    peakResident = Math.max(peakResident, streamed.residentGroups);
    if (r.allDone) break;
  }
  const ssol = await streamed.readSolutions(out);
  const t4 = performance.now();
  const streamGroups = streamed.groupCount;
  streamed.destroy();
  const streamedBitwiseEqual =
    bitHash(out) === residentHash && ssol.iterations.every((it, c) => it === iterations[c]);

  const validation = await device.popErrorScope();
  const oom = await device.popErrorScope();
  if (oom) throw new Error(`GPU out of memory for N=${N} T=${T}: ${oom.message}`);
  if (validation) throw new Error(`GPU validation error: ${validation.message}`);
  const conv = sol.converged.reduce((a, b) => a + b, 0);
  const maxIt = Math.max(...iterations);
  const res = {
    N,
    T,
    groups,
    prepMs: t1 - t0,
    loadSolveReadMs: t2 - t1,
    convergedCells: conv,
    maxIterations: maxIt,
    streamed: {
      budgetBytes: budget,
      groups: streamGroups,
      peakResident,
      loadSolveReadMs: t4 - t3,
      bitwiseEqual: streamedBitwiseEqual,
    },
  };
  log(
    `[full] N=${N} T=${T} groups=${groups} load+solve+readback=${(t2 - t1).toFixed(0)} ms ` +
      `converged=${conv}/${N} maxIters=${maxIt}; streamed (1 GiB budget): ${streamGroups} groups, ` +
      `peak resident ${peakResident}, ${(t4 - t3).toFixed(0)} ms, bitwise equal=${streamedBitwiseEqual}`,
  );
  return res;
}

/**
 * Warm-start continuity in both directions, CaTune-like problem, 4 cells.
 * WASM -> GPU: WASM runs 40 iterations, export_state; the GPU continues from
 * that state (with momentum, and with momentum reset for contrast) and is
 * compared with WASM continuing itself. GPU -> WASM: the GPU runs 40
 * iterations and exports its state (codec layout); WASM load_state continues
 * and is compared with the GPU continuing itself.
 */
async function warmCase(gpu: GpuFista, raws: Float32Array[]): Promise<Record<string, unknown>> {
  const p = CATUNE;
  const SPLIT = 40;
  const n = raws.length;
  const prepped = (raw: Float32Array, params: GpuFistaParams = p) => {
    const s = newSolver(params);
    s.set_trace(raw);
    s.set_filter_enabled(true);
    s.apply_filter();
    s.subtract_baseline();
    return s;
  };
  const finish = (s: Solver) => {
    while (!s.converged() && s.iteration_count() < p.maxIters) s.step_batch(50);
    const out = { solution: s.get_solution(), iterations: s.iteration_count() };
    s.free();
    return out;
  };
  // WASM -> GPU
  const states: Uint8Array[] = [];
  const wasmRef: { solution: Float32Array; iterations: number }[] = [];
  const working: Float32Array[] = [];
  for (const raw of raws) {
    const s = prepped(raw);
    working.push(s.get_trace());
    s.step_batch(SPLIT);
    states.push(s.export_state());
    wasmRef.push(finish(s));
  }
  const T = working[0].length;
  const traces = new Float32Array(n * T);
  working.forEach((w, c) => traces.set(w, c * T));
  const decoded = states.map((b) => decodeSolverState(b)!);
  const warmOf = (momentum: boolean) => {
    const solution = new Float32Array(n * T);
    const prev = new Float32Array(n * T);
    decoded.forEach((d, c) => {
      solution.set(d.solution, c * T);
      prev.set(d.solutionPrev, c * T);
    });
    return {
      solution,
      prev,
      momentum: new Uint8Array(n).fill(momentum ? 1 : 0),
      tFista: Float64Array.from(decoded, (d) => d.tFista),
      iterations: Uint32Array.from(decoded, (d) => d.iteration),
    };
  };
  const gp = { ...p, filtered: true };
  const runGpu = async (momentum: boolean) => {
    await gpu.load(traces, n, T, gp, warmOf(momentum));
    const sol = await gpu.solve(50);
    gpu.destroy();
    return sol;
  };
  const withMomentum = await runGpu(true);
  const reset = await runGpu(false);
  const cmp = (sol: { solutions: Float32Array; iterations: Uint32Array }) =>
    wasmRef.map((r, c) => ({
      relL2: relL2(sol.solutions.subarray(c * T, (c + 1) * T), r.solution),
      gpuIters: SPLIT + sol.iterations[c],
      wasmIters: r.iterations,
    }));
  const wasmToGpu = cmp(withMomentum);
  const wasmToGpuReset = cmp(reset);

  // GPU -> WASM
  await gpu.load(traces, n, T, gp);
  await gpu.step(SPLIT);
  const mid = await gpu.readSolutionsFor(
    Array.from({ length: n }, (_, c) => c),
    { withState: true },
  );
  const gpuStates = Array.from({ length: n }, (_, c) =>
    encodeSolverState({
      solution: mid.solutions.subarray(c * T, (c + 1) * T),
      solutionPrev: mid.state!.prev.subarray(c * T, (c + 1) * T),
      tFista: mid.state!.tFista[c],
      iteration: mid.iterations[c],
      baseline: mid.state!.baseline[c],
    }),
  );
  const gpuFinal = await gpu.solve(50);
  gpu.destroy();
  const gpuToWasm = raws.map((raw, c) => {
    const s = prepped(raw);
    s.load_state(gpuStates[c]);
    const r = finish(s);
    return {
      relL2: relL2(gpuFinal.solutions.subarray(c * T, (c + 1) * T), r.solution),
      gpuIters: gpuFinal.iterations[c],
      wasmIters: r.iterations,
    };
  });
  // Lambda change (CaTune's 'warm' strategy): a state converged at lambda 0.5
  // continues at lambda 0.05, on both solvers; and both solve cold at 0.05.
  const p2: GpuFistaParams = { ...p, lambda: 0.05, maxIters: 20000 };
  const lambdaRef: { solution: Float32Array; iterations: number }[] = [];
  const coldRef: { solution: Float32Array; iterations: number }[] = [];
  const convStates: Uint8Array[] = [];
  for (const raw of raws) {
    const s = prepped(raw);
    while (!s.converged() && s.iteration_count() < p.maxIters) s.step_batch(50);
    convStates.push(s.export_state());
    s.free();
    const s2 = prepped(raw, p2);
    s2.load_state(convStates[convStates.length - 1]);
    lambdaRef.push(finish(s2));
    coldRef.push(finish(prepped(raw, p2)));
  }
  const cd = convStates.map((b) => decodeSolverState(b)!);
  const lw = {
    solution: new Float32Array(n * T),
    prev: new Float32Array(n * T),
    momentum: new Uint8Array(n).fill(1),
    tFista: Float64Array.from(cd, (d) => d.tFista),
    iterations: Uint32Array.from(cd, (d) => d.iteration),
  };
  cd.forEach((d, c) => {
    lw.solution.set(d.solution, c * T);
    lw.prev.set(d.solutionPrev, c * T);
  });
  const gp2 = { ...p2, filtered: true };
  await gpu.load(traces, n, T, gp2, lw);
  const lsol = await gpu.solve(50);
  gpu.destroy();
  await gpu.load(traces, n, T, gp2);
  const csol = await gpu.solve(50);
  gpu.destroy();
  const lambdaChange = lambdaRef.map((r, c) => ({
    relL2: relL2(lsol.solutions.subarray(c * T, (c + 1) * T), r.solution),
    gpuIters: cd[c].iteration + lsol.iterations[c],
    wasmIters: r.iterations,
  }));
  const coldAtNewLambda = coldRef.map((r, c) => ({
    relL2: relL2(csol.solutions.subarray(c * T, (c + 1) * T), r.solution),
    gpuIters: csol.iterations[c],
    wasmIters: r.iterations,
  }));

  const worst = (xs: { relL2: number }[]) => Math.max(...xs.map((x) => x.relL2));
  log(
    `\n[warm] N=${n} T=${T} split at ${SPLIT}: WASM->GPU worst relL2 ${worst(wasmToGpu).toExponential(2)} ` +
      `(momentum reset instead: ${worst(wasmToGpuReset).toExponential(2)}); GPU->WASM worst relL2 ` +
      `${worst(gpuToWasm).toExponential(2)}`,
  );
  for (const [name, xs] of [
    ['WASM->GPU', wasmToGpu],
    ['WASM->GPU reset', wasmToGpuReset],
    ['GPU->WASM', gpuToWasm],
    ['lambda 0.5 -> 0.05 (warm)', lambdaChange],
    ['cold at lambda 0.05', coldAtNewLambda],
  ] as const) {
    log(
      `  ${name}: ` +
        xs.map((x) => `${x.relL2.toExponential(1)} it ${x.gpuIters}/${x.wasmIters}`).join(', '),
    );
  }
  return { split: SPLIT, wasmToGpu, wasmToGpuReset, gpuToWasm, lambdaChange, coldAtNewLambda };
}

async function main(): Promise<void> {
  window.__gpuSpike = { status: 'running' };
  const mode = new URLSearchParams(location.search).get('mode') ?? 'all';
  await initWasm();
  const device = await requestGpuDevice();
  if (!device) throw new Error('WebGPU unavailable (navigator.gpu or adapter missing)');
  const ai = device.adapterInfo;
  const adapter =
    [ai?.vendor, ai?.architecture, ai?.device, ai?.description].filter(Boolean).join(' / ') ||
    'unknown';
  device.addEventListener('uncapturederror', (e) =>
    log(`GPU error: ${(e as GPUUncapturedErrorEvent).error.message}`),
  );
  log(
    `Adapter: ${adapter}\nmaxStorageBufferBindingSize=${device.limits.maxStorageBufferBindingSize} ` +
      `maxBufferSize=${device.limits.maxBufferSize}`,
  );
  const gpu = await createGpuFista(device);
  const result: Record<string, unknown> = { adapter };

  const raw30 = simulate(16, 27000, 42);
  if (mode === 'equiv' || mode === 'all') {
    const cases: CaseResult[] = [];
    cases.push(
      await equivCase(gpu, 'CaTune-like (filter + baseline subtract)', raw30, CATUNE, 'catune'),
    );
    const working = raw30.slice(0, 8).map((r) => catuneWorkingTrace(r, CATUNE));
    cases.push(
      await equivCase(
        gpu,
        'CaDecon-like (10x upsampled working trace, subtract_baseline)',
        working.map((w) => upsample(w, 10)),
        CADECON,
        'subtract',
      ),
    );
    cases.push(
      await equivCase(
        gpu,
        'Unfiltered (baseline re-estimated each iteration)',
        raw30.slice(0, 8),
        { ...CATUNE, filtered: false },
        'none',
      ),
    );
    result.equivalence = cases;
  }
  if (mode === 'groups' || mode === 'all') {
    result.grouping = await groupingCase(device, gpu, raw30.slice(0, 8));
  }
  if (mode === 'warm' || mode === 'all') {
    result.warm = await warmCase(gpu, raw30.slice(0, 4));
  }
  if (mode === 'full') {
    const pool = raw30.map((r) => catuneWorkingTrace(r, CATUNE));
    result.full = await fullPass(device, gpu, pool, 1024);
  }
  if (mode === 'bench' || mode === 'all') {
    const pool = raw30.map((r) => catuneWorkingTrace(r, CATUNE));
    const rows = await bench(device, gpu, pool);
    result.bench = rows;
    result.benchTable = benchTable(rows, adapter);
    log('\n' + (result.benchTable as string));
  }
  const json = JSON.stringify(result, null, 2);
  log('\nGPU-SPIKE-RESULT ' + json.length + ' bytes of JSON follow');
  console.log('GPU-SPIKE-RESULT ' + JSON.stringify(result));
  lines.push(json);
  logEl.textContent = lines.join('\n');
  window.__gpuSpike = { status: 'done', result };
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  log(`ERROR: ${msg}`);
  window.__gpuSpike = { status: 'error', error: msg };
});
