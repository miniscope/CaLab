// Iteration Manager: orchestrates the InDeCa iterative deconvolution loop.
//
// Loop per iteration:
//   1. Per-trace inference on subset cells (parallel trace-jobs)
//   2. Per-subset kernel estimation (parallel kernel-jobs)
//   3. Merge: median tauRise/tauDecay across subsets
//   4. Convergence check
//   5. On convergence/max iters: finalization pass on ALL cells

import { batch } from 'solid-js';
import {
  tauToShape,
  shapeToTau,
  kernelShapeRmse,
  KERNEL_DURATION_MULTIPLE,
  type WorkerPool,
} from '@calab/compute';
import { createCaDeconWorkerPool, type CaDeconPoolJob } from './cadecon-pool.ts';
import type {
  TraceResult,
  KernelResult,
  SeedTraceResult,
  WarmBiexp,
  FitMode,
} from '../workers/cadecon-types.ts';
import {
  runState,
  setRunState,
  setRunPhase,
  setCurrentIteration,
  setTotalSubsetTraceJobs,
  setCompletedSubsetTraceJobs,
  setCurrentTauRise,
  setCurrentTauDecay,
  setConvergedAtIteration,
  setRunError,
  setFailedJobs,
  addConvergenceSnapshot,
  addDebugTraceSnapshot,
  updateTraceResult,
  bulkUpdateTraceResults,
  resetIterationState,
  snapshotIteration,
  cellSubsetKey,
} from './iteration-store.ts';
import {
  upsampleFactor,
  maxIterations,
  convergenceTol,
  convergencePatience,
  convergenceMinIters,
  finalSelectionWindow,
  hpFilterEnabled,
  lpFilterEnabled,
  noiseConstrained,
  sparsityCompareEnabled,
  traceFistaMaxIters,
  traceFistaTol,
  kernelFistaMaxIters,
  kernelFistaTol,
  kernelSmoothLambda,
} from './algorithm-store.ts';
import {
  parsedData,
  samplingRate,
  numCells,
  numTimepoints,
  swapped,
  effectiveShape,
} from './data-store.ts';
import { subsetRectangles, type SubsetRectangle } from './subset-store.ts';
import { dataIndex } from '@calab/io';
import { median } from './math-utils.ts';
import { reconvolveAR2 } from './reconvolve.ts';

// Per-trace and per-kernel FISTA solver parameters are configurable via
// algorithm-store (traceFistaMaxIters/Tol, kernelFistaMaxIters/Tol,
// kernelSmoothLambda) so they are overridable and recorded with the run. Like
// every other run parameter they are snapshotted once at run start
// (SolverSettings), so editing them mid-run cannot change a run in progress.
/** Number of early free-kernel samples to skip in bi-exponential fitting. */
export const BIEXP_FIT_SKIP = 0;

/**
 * A kernel-estimation result tagged with the subset it came from.
 * Kernel jobs complete in worker-completion order (not dispatch order), so the
 * subset index must travel with each result rather than being inferred from
 * array position — otherwise per-subset kernels, warm-starts, and snapshots get
 * bound to the wrong subset when jobs finish out of order.
 */
type KernelJobResult = KernelResult & { subsetIdx: number };

/**
 * Whether a subset's bi-exponential fit is entitled to vote on the reported
 * kernel.
 *
 * `Degenerate` means the fit found no positive slow amplitude (beta <= 0) — the
 * free kernel it was handed was noise or flat, with no real transient in it.
 * `Empty` means no fit was produced at all, leaving sentinel time constants and
 * an infinite residual. Neither describes a calcium kernel, so neither belongs
 * in a median that becomes the number CaDecon reports and submits.
 *
 * The median is not a defence here. Subset counts are small (4 by default), so
 * two degenerate subsets out of four decide the median outright, and even one
 * shifts it. `Empty` is worse than a shift: its infinite residual poisons any
 * mean or median it reaches.
 */
function isTrustworthyFit(r: { fitMode: FitMode }): boolean {
  return r.fitMode !== 'Degenerate' && r.fitMode !== 'Empty';
}

/** Absolute floor of the Rust tau_rise clamp (mirrors biexp_fit.rs tau_r_lo). */
const RISE_CLAMP_FLOOR_S = 0.005;
/** tau_rise within this factor of the clamp floor is flagged "rise unresolved". */
const RISE_FLOOR_MARGIN = 1.05;
/** Denominator guard for the normalized trace-stability delta. */
const STABILITY_EPS = 1e-9;
/** Minimum activity norm for a cell to enter the trace-stability median (excludes silent cells). */
const STABILITY_MIN_ACTIVITY = 1e-6;

/** Sum of squares of an array. */
function sumSq(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s;
}

/**
 * Median normalized L2 change in per-cell activity between two iterations'
 * stitched s_counts maps: median over cells present in both (and non-silent) of
 * ||s_new - s_old|| / (max(||s_new||, ||s_old||) + eps). Returns null if no
 * comparable cells.
 *
 * The symmetric max(...) denominator keeps the ratio bounded to [0, sqrt(2)] and
 * stops it from exploding when a cell's activity collapses toward zero between
 * iterations (which a ||s_new||-only denominator would). s_counts are native-rate
 * bin counts (the solver downsamples the upsampled train before returning), so
 * this measures change at the resolution the data actually constrains.
 */
function computeTraceStability(
  prev: Map<number, Float32Array> | undefined,
  next: Map<number, Float32Array>,
): number | null {
  if (!prev || prev.size === 0) return null;
  const deltas: number[] = [];
  for (const [cell, sNew] of next) {
    const sOld = prev.get(cell);
    if (!sOld || sOld.length !== sNew.length) continue;
    const normNew = Math.sqrt(sumSq(sNew));
    const normOld = Math.sqrt(sumSq(sOld));
    const denom = Math.max(normNew, normOld);
    if (denom < STABILITY_MIN_ACTIVITY) continue;
    let diff = 0;
    for (let i = 0; i < sNew.length; i++) {
      const d = sNew[i] - sOld[i];
      diff += d * d;
    }
    deltas.push(Math.sqrt(diff) / (denom + STABILITY_EPS));
  }
  return deltas.length > 0 ? median(deltas) : null;
}

type Pool = WorkerPool<CaDeconPoolJob>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A job as the phase code describes it; runJobs assigns the id and settle callbacks. */
type JobSpec = DistributiveOmit<CaDeconPoolJob, 'jobId' | 'onCancelled' | 'onError'>;

/**
 * The live run's pool, kept at module level only so stopRun/resetRun can reach
 * it. The run loop itself uses the pool it created (passed down as a local), so
 * a reset that nulls or replaces this can never make an old loop dispatch onto
 * the wrong pool or onto null.
 */
let pool: Pool | null = null;
let nextJobId = 0;
let pauseResolver: (() => void) | null = null;
/**
 * Run generation. Each startRun captures `++currentRun`; resetRun bumps it.
 * After every await the loop checks it still owns the generation and bails
 * (via RunSuperseded) if not, so a reset run never resumes.
 */
let currentRun = 0;

/** A phase aborts the run when more than this fraction of its jobs failed. */
const MAX_PHASE_FAILURE_FRACTION = 0.5;

/** Thrown inside a run to unwind it silently: a newer run (or reset) owns the state. */
class RunSuperseded extends Error {}

function assertCurrent(runId: number): void {
  if (runId !== currentRun) throw new RunSuperseded();
}

/** Outcome of one batch of jobs. Cancelled jobs are neither failures nor results. */
interface PhaseOutcome {
  total: number;
  failed: number;
  firstError: string | null;
}

/**
 * Dispatch `count` jobs and resolve once every one has settled (completed,
 * cancelled, or failed). `makeJob` builds job `i`; its `onComplete` must do its
 * own bookkeeping and then call `settle()`. Failures are counted here.
 */
function runJobs(
  runPool: Pool,
  count: number,
  makeJob: (i: number, settle: () => void) => JobSpec | null,
  onSettled?: (settled: number) => void,
): Promise<PhaseOutcome> {
  return new Promise((resolve) => {
    const outcome: PhaseOutcome = { total: 0, failed: 0, firstError: null };
    let settled = 0;
    let dispatching = true;
    const settle = (): void => {
      settled++;
      onSettled?.(settled);
      if (!dispatching && settled === outcome.total) resolve(outcome);
    };
    for (let i = 0; i < count; i++) {
      const job = makeJob(i, settle);
      if (!job) continue;
      outcome.total++;
      runPool.dispatch({
        ...job,
        jobId: nextJobId++,
        onCancelled: settle,
        onError(msg: string) {
          outcome.failed++;
          outcome.firstError ??= msg;
          settle();
        },
      });
    }
    // Jobs may settle synchronously (e.g. a fatal or disposed pool), so only
    // resolve once every job has been dispatched.
    dispatching = false;
    if (settled === outcome.total) resolve(outcome);
  });
}

/**
 * Record a phase's job failures and abort the run if too many failed. A
 * phase where most jobs failed would otherwise quietly produce a fallback
 * kernel (or none) and report the run as complete.
 */
function checkPhase(phase: string, outcome: PhaseOutcome): void {
  if (outcome.failed === 0) return;
  setFailedJobs((n) => n + outcome.failed);
  console.warn(
    `[CaDecon] ${outcome.failed}/${outcome.total} ${phase} jobs failed:`,
    outcome.firstError,
  );
  if (outcome.failed > outcome.total * MAX_PHASE_FAILURE_FRACTION) {
    throw new Error(
      `${outcome.failed} of ${outcome.total} ${phase} jobs failed` +
        (outcome.firstError ? `: ${outcome.firstError}` : ''),
    );
  }
}

/** Per-run snapshot of the FISTA solver settings (read once, not live mid-run). */
interface SolverSettings {
  traceMaxIters: number;
  traceTol: number;
  kernelMaxIters: number;
  kernelTol: number;
  kernelSmoothLambda: number;
}

// --- Helpers ---

/** Extract a cell's trace segment from the data matrix between tStart and tEnd. */
function extractCellTrace(
  cellIndex: number,
  tStart: number,
  tEnd: number,
  data: { data: ArrayLike<number>; shape: number[] },
  isSwapped: boolean,
): Float32Array {
  const rawCols = data.shape[1];
  const len = tEnd - tStart;
  const trace = new Float32Array(len);
  for (let t = 0; t < len; t++) {
    const idx = dataIndex(cellIndex, tStart + t, rawCols, isSwapped);
    trace[t] = Number(data.data[idx]);
  }
  return trace;
}

// --- Dispatch helpers ---

type TraceInput = { data: ArrayLike<number>; shape: number[] };

/** Flatten subset rectangles into one (cell, rect, subsetIdx) entry per cell×subset. */
function subsetCellJobs(
  rects: SubsetRectangle[],
): { cell: number; rect: SubsetRectangle; subsetIdx: number }[] {
  const jobs: { cell: number; rect: SubsetRectangle; subsetIdx: number }[] = [];
  for (let si = 0; si < rects.length; si++) {
    const rect = rects[si];
    for (let c = rect.cellStart; c < rect.cellEnd; c++) {
      jobs.push({ cell: c, rect, subsetIdx: si });
    }
  }
  return jobs;
}

/**
 * Run trace inference for all cells in all subsets.
 * Returns an array (one per subset) of Map<cellIndex, TraceResult>.
 */
async function dispatchTraceJobs(
  runPool: Pool,
  rects: SubsetRectangle[],
  data: TraceInput,
  isSwapped: boolean,
  tauR: number,
  tauD: number,
  fs: number,
  upFactor: number,
  maxIters: number,
  tol: number,
  hpEnabled: boolean,
  lpEnabled: boolean,
  lambda: number,
  noiseConstrained: boolean,
  computeComparison: boolean,
  prevResults?: Map<number, Float32Array>,
): Promise<{ results: Array<Map<number, TraceResult>>; outcome: PhaseOutcome }> {
  const jobs = subsetCellJobs(rects);
  setTotalSubsetTraceJobs(jobs.length);
  setCompletedSubsetTraceJobs(0);

  const results: Array<Map<number, TraceResult>> = rects.map(() => new Map());
  const outcome = await runJobs(
    runPool,
    jobs.length,
    (i, settle) => {
      const { cell, rect, subsetIdx } = jobs[i];
      const trace = extractCellTrace(cell, rect.tStart, rect.tEnd, data, isSwapped);

      // Warm-start: extract the relevant segment of previous s_counts for this subset window.
      // Previous s_counts cover the full trace; we need just [tStart, tEnd).
      let warmCounts: Float32Array | undefined;
      const prevCounts = prevResults?.get(cell);
      if (prevCounts && prevCounts.length > 0) {
        warmCounts = prevCounts.subarray(rect.tStart, rect.tEnd);
      }

      return {
        kind: 'trace',
        trace,
        tauRise: tauR,
        tauDecay: tauD,
        fs,
        upsampleFactor: upFactor,
        maxIters,
        tol,
        hpEnabled,
        lpEnabled,
        lambda,
        noiseConstrained,
        computeComparison,
        warmCounts,
        onComplete(result: TraceResult) {
          results[subsetIdx].set(cell, result);
          settle();
        },
      };
    },
    setCompletedSubsetTraceJobs,
  );
  return { results, outcome };
}

/** Run kernel estimation for each subset. Returns per-subset kernel results. */
async function dispatchKernelJobs(
  runPool: Pool,
  solver: SolverSettings,
  rects: SubsetRectangle[],
  perSubsetResults: Array<Map<number, TraceResult>>,
  data: TraceInput,
  isSwapped: boolean,
  fs: number,
  kernelLength: number,
  prevKernels?: Float32Array[],
  prevBiexpResults?: WarmBiexp[],
): Promise<{ results: KernelJobResult[]; outcome: PhaseOutcome }> {
  const kernelResults: KernelJobResult[] = [];

  const outcome = await runJobs(runPool, rects.length, (si, settle) => {
    const rect = rects[si];
    const subsetResults = perSubsetResults[si];

    // Two-pass: first identify valid cells and count total length, then allocate and fill
    type ValidCell = {
      trace: Float32Array;
      sCounts: Float32Array;
      alpha: number;
      baseline: number;
    };
    const validCells: ValidCell[] = [];
    let totalSamples = 0;

    for (let c = rect.cellStart; c < rect.cellEnd; c++) {
      const r = subsetResults.get(c);
      if (!r) continue;
      if (r.alpha === 0 || r.sCounts.every((v) => v === 0)) continue;

      // Use the working trace (after filter + baseline subtraction) for kernel
      // estimation — this is the domain the solver operated in. Fall back to
      // raw only if the working trace is unavailable.
      const trace = r.filteredTrace
        ? r.filteredTrace
        : extractCellTrace(c, rect.tStart, rect.tEnd, data, isSwapped);
      validCells.push({ trace, sCounts: r.sCounts, alpha: r.alpha, baseline: r.baseline });
      totalSamples += trace.length;
    }

    // Subsets with no valid traces dispatch no job.
    if (validCells.length === 0) return null;

    const tracesFlat = new Float32Array(totalSamples);
    const spikesFlat = new Float32Array(totalSamples);
    const traceLengths = new Uint32Array(validCells.length);
    const alphas = new Float64Array(validCells.length);
    const baselines = new Float64Array(validCells.length);

    let offset = 0;
    for (let i = 0; i < validCells.length; i++) {
      const vc = validCells[i];
      tracesFlat.set(vc.trace, offset);
      spikesFlat.set(vc.sCounts, offset);
      traceLengths[i] = vc.trace.length;
      alphas[i] = vc.alpha;
      baselines[i] = vc.baseline;
      offset += vc.trace.length;
    }

    // Warm-start: use previous iteration's kernel and biexp result for this subset
    const warmKernel = prevKernels?.[si];
    const warmBiexp = prevBiexpResults?.[si];

    return {
      kind: 'kernel',
      tracesFlat,
      spikesFlat,
      traceLengths,
      alphas,
      baselines,
      kernelLength,
      fs,
      maxIters: solver.kernelMaxIters,
      tol: solver.kernelTol,
      refine: true,
      smoothLambda: solver.kernelSmoothLambda,
      biexpSkip: BIEXP_FIT_SKIP,
      warmKernel,
      warmBiexp,
      onComplete(result: KernelResult) {
        kernelResults.push({ ...result, subsetIdx: si });
        settle();
      },
    };
  });
  return { results: kernelResults, outcome };
}

// --- Seed trace dispatch (parallel, Rust WASM via worker pool) ---

/**
 * Dispatch seed-trace jobs for all cells in all subsets.
 * Each worker runs Rust peak detection (find_seed_spikes) — no kernel needed.
 * Returns the same shape as dispatchTraceJobs so it feeds directly into dispatchKernelJobs.
 */
async function dispatchSeedTraceJobs(
  runPool: Pool,
  rects: SubsetRectangle[],
  data: TraceInput,
  isSwapped: boolean,
  fs: number,
): Promise<{ results: Array<Map<number, TraceResult>>; outcome: PhaseOutcome }> {
  const jobs = subsetCellJobs(rects);
  setTotalSubsetTraceJobs(jobs.length);
  setCompletedSubsetTraceJobs(0);

  const results: Array<Map<number, TraceResult>> = rects.map(() => new Map());
  const outcome = await runJobs(
    runPool,
    jobs.length,
    (i, settle) => {
      const { cell, rect, subsetIdx } = jobs[i];
      return {
        kind: 'seed-trace',
        trace: extractCellTrace(cell, rect.tStart, rect.tEnd, data, isSwapped),
        fs,
        onComplete(result: SeedTraceResult) {
          // Wrap SeedTraceResult into a TraceResult so it feeds into dispatchKernelJobs
          results[subsetIdx].set(cell, {
            sCounts: result.sCounts,
            alpha: result.alpha,
            baseline: result.baseline,
            threshold: 0,
            pve: 0,
            iterations: 0,
            converged: true,
          });
          settle();
        },
      };
    },
    setCompletedSubsetTraceJobs,
  );
  return { results, outcome };
}

// --- Main Loop ---

type RunData = NonNullable<ReturnType<typeof parsedData>>;

/**
 * Start a run. Never rejects: callers fire it with `void startRun()`.
 *
 * Every exit leaves a terminal state: 'complete' (finished, or stopped early by
 * the user — partial results are kept), 'error' (a thrown error, a fatal pool,
 * or too many job failures; the reason is in `runError`), or untouched if a
 * resetRun superseded this run (reset already moved the store to 'idle'). The
 * run's pool is disposed on every exit.
 */
export async function startRun(): Promise<void> {
  const data = parsedData();
  const fs = samplingRate();
  const shape = effectiveShape();
  if (!data || !fs || !shape) return;

  // Supersede any previous run that is somehow still live.
  const runId = ++currentRun;
  pool?.dispose();

  setRunError(null);
  setFailedJobs(0);
  const runPool = createCaDeconWorkerPool(undefined, {
    onFatal(message) {
      console.error('[CaDecon] solver workers failed:', message);
      if (runId === currentRun) setRunError(`Solver workers failed: ${message}`);
    },
  });
  pool = runPool;
  setRunState('running');

  try {
    await executeRun(runId, runPool, data, fs);
    if (runId === currentRun) {
      setRunPhase('idle');
      setRunState('complete');
    }
  } catch (err) {
    if (err instanceof RunSuperseded || runId !== currentRun) return;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[CaDecon] run failed:', err);
    // Prefer the pool's root cause (e.g. WASM failed to load) over the
    // downstream "N jobs failed" it produces.
    setRunError((prev) => prev ?? message);
    setRunPhase('idle');
    setRunState('error');
  } finally {
    runPool.dispose();
    if (pool === runPool) pool = null;
    if (runId === currentRun) pauseResolver = null;
  }
}

async function executeRun(runId: number, runPool: Pool, data: RunData, fs: number): Promise<void> {
  // Snapshot parameters — tau values are auto-detected by the seed phase below;
  // these fallbacks are only used if the seed phase yields zero kernel results.
  const TAU_RISE_FALLBACK = 0.2;
  const TAU_DECAY_FALLBACK = 1.0;
  let tauR = TAU_RISE_FALLBACK;
  let tauD = TAU_DECAY_FALLBACK;
  const upFactor = upsampleFactor();
  const maxIter = maxIterations();
  // Convergence controls (see algorithm-store / CONVERGENCE_RANGES). convTol is
  // the kernel-RMSE threshold; selWindow is still a shape-space (median) control.
  const convTol = convergenceTol();
  const patience = convergencePatience();
  const minIters = convergenceMinIters();
  const selWindow = finalSelectionWindow();
  // tau_rise clamp floor mirrored from the Rust biexp fit (biexp_fit.rs:
  // tau_r_lo = max(1/fs, 0.005)); used only to flag an unresolved rise.
  const tauRiseFloor = Math.max(1 / fs, RISE_CLAMP_FLOOR_S);
  const rects = subsetRectangles();
  const isSwap = swapped();
  const nCells = numCells();
  const nTp = numTimepoints();
  const hpOn = hpFilterEnabled();
  const lpOn = lpFilterEnabled();
  const sparsityLambda = 0.0;
  const noiseConstrainedOn = noiseConstrained();
  const computeComparison = sparsityCompareEnabled();
  const solver: SolverSettings = {
    traceMaxIters: traceFistaMaxIters(),
    traceTol: traceFistaTol(),
    kernelMaxIters: kernelFistaMaxIters(),
    kernelTol: kernelFistaTol(),
    kernelSmoothLambda: kernelSmoothLambda(),
  };

  setCurrentIteration(0);

  // Seed phase: detect peaks in raw traces → kernel estimation → bootstrap taus.
  // Uses the same subset rectangles and dispatchKernelJobs as the iterative loop,
  // but replaces FISTA trace inference with Rust peak detection (no kernel needed).
  setRunPhase('inference');
  const seedTraces = await dispatchSeedTraceJobs(runPool, rects, data, isSwap, fs);
  assertCurrent(runId);
  checkPhase('seed-trace', seedTraces.outcome);
  const seedTraceResults = seedTraces.results;

  if (runState() === 'stopping') return;

  // Use a generous kernel length for the seed phase (~1.5s) since tauD is unknown
  const seedKernelLength = Math.max(10, Math.min(200, Math.ceil(1.5 * fs)));

  setRunPhase('kernel-update');
  const seedKernels = await dispatchKernelJobs(
    runPool,
    solver,
    rects,
    seedTraceResults,
    data,
    isSwap,
    fs,
    seedKernelLength,
  );
  assertCurrent(runId);
  checkPhase('seed-kernel', seedKernels.outcome);
  const seedKernelResults = seedKernels.results;

  // Seed only from subsets whose fit resolved a real transient. A degenerate
  // seed is worse than no seed: it is not merely inaccurate, it points the
  // first spike solve at a kernel shape derived from noise, and every later
  // iteration warm-starts from there. When nothing is trustworthy, keep the
  // generic fallback taus — a known-generic starting point the loop can climb
  // out of, rather than a specific wrong one it will trust.
  const trustworthySeeds = seedKernelResults.filter(isTrustworthyFit);
  if (trustworthySeeds.length > 0) {
    const seedTauRises: number[] = new Array(trustworthySeeds.length);
    const seedTauDecays: number[] = new Array(trustworthySeeds.length);
    for (let i = 0; i < trustworthySeeds.length; i++) {
      seedTauRises[i] = trustworthySeeds[i].tauRise;
      seedTauDecays[i] = trustworthySeeds[i].tauDecay;
    }
    tauR = median(seedTauRises);
    tauD = median(seedTauDecays);
    setCurrentTauRise(tauR);
    setCurrentTauDecay(tauD);
    const discarded = seedKernelResults.length - trustworthySeeds.length;
    console.log(
      `[CaDecon] Auto-init kernel: τ_rise=${(tauR * 1000).toFixed(1)}ms, τ_decay=${(tauD * 1000).toFixed(1)}ms` +
        (discarded > 0
          ? ` (from ${trustworthySeeds.length}/${seedKernelResults.length} subsets; ${discarded} had no resolvable transient)`
          : ''),
    );
  } else if (seedKernelResults.length > 0) {
    console.warn(
      `[CaDecon] Seed kernel estimation produced no usable fit across ` +
        `${seedKernelResults.length} subset(s); starting from fallback ` +
        `τ_rise=${TAU_RISE_FALLBACK}s, τ_decay=${TAU_DECAY_FALLBACK}s.`,
    );
  }

  if (runState() === 'stopping') return;

  // Kernel length: KERNEL_DURATION_MULTIPLE x tau_decay in samples (matches CaTune's computeKernel convention)
  const kernelLength = Math.max(10, Math.ceil(KERNEL_DURATION_MULTIPLE * tauD * fs));

  // Warm-start state carried between iterations
  let prevTraceCounts: Map<number, Float32Array> | undefined;
  let prevKernels: Float32Array[] | undefined;
  let prevBiexpResults: WarmBiexp[] | undefined;

  // Convergence tracking. We test convergence with the peak-normalized RMSE
  // between successive iterations' bi-exponential kernels (kernelShapeRmse): an
  // iteration is "stable" when that whole-waveform change is < convTol, and we
  // declare convergence after `patience` consecutive stable iterations. RMSE on
  // the waveform avoids the old (tPeak, FWHM) relative delta's over-sensitivity to
  // t_peak jitter on the poorly-constrained rising edge. (tPeak/FWHM are still
  // tracked for the Kernel-tab diagnostics and the final-selection step.) The
  // final kernel is the median of the last `selWindow` iterates' shapes — not the
  // argmin of the (bouncy, unreliable) bi-exponential residual.
  let prevShape = tauToShape(tauR, tauD);
  let prevTauR = tauR;
  let prevTauD = tauD;
  let stableCount = 0;
  let firstStableIter: number | null = null;
  const shapeTrail: Array<{ tauRise: number; tauDecay: number; tPeak: number; fwhm: number }> = [];

  // Iteration 0: record initial kernel state and alpha=1 baseline
  batch(() => {
    addConvergenceSnapshot({
      iteration: 0,
      tauRise: tauR,
      tauDecay: tauD,
      beta: 0,
      // No fit has run yet; this snapshot records the seed kernel only.
      residual: null,
      tauRiseFast: 0,
      tauDecayFast: 0,
      betaFast: 0,
      fs,
      tPeak: prevShape?.tPeak ?? null,
      fwhm: prevShape?.fwhm ?? null,
      kernelRmse: null,
      riseUnresolved: false,
      kernelFitR2: null,
      medianPve: null,
      traceStability: null,
      degenerateSubsets: 0,
      totalSubsetFits: 0,
      subsets: [],
    });
    const initEntries: Record<string, import('./iteration-store.ts').TraceResultEntry> = {};
    for (let si = 0; si < rects.length; si++) {
      const rect = rects[si];
      for (let c = rect.cellStart; c < rect.cellEnd; c++) {
        initEntries[cellSubsetKey(c, si)] = {
          cellIndex: c,
          subsetIdx: si,
          sCounts: new Float32Array(0),
          alpha: 1,
          baseline: 0,
          threshold: 0,
          pve: 0,
        };
      }
    }
    bulkUpdateTraceResults(initEntries);
    snapshotIteration(0, tauR, tauD);
  });

  for (let iter = 0; iter < maxIter; iter++) {
    // Check for stop/pause
    if (runState() === 'stopping') break;
    if (runState() === 'paused') {
      await new Promise<void>((resolve) => {
        pauseResolver = resolve;
      });
      assertCurrent(runId);
      if (runState() === 'stopping') break;
    }

    setCurrentIteration(iter + 1);

    // Step 1: Per-trace inference (warm-started from previous iteration's s_counts)
    setRunPhase('inference');
    const traceJobs = await dispatchTraceJobs(
      runPool,
      rects,
      data,
      isSwap,
      tauR,
      tauD,
      fs,
      upFactor,
      solver.traceMaxIters,
      solver.traceTol,
      hpOn,
      lpOn,
      sparsityLambda,
      noiseConstrainedOn,
      computeComparison,
      prevTraceCounts,
    );
    assertCurrent(runId);
    checkPhase('trace inference', traceJobs.outcome);
    const traceResults = traceJobs.results;

    if (runState() === 'stopping') break;

    // Collect s_counts for warm-starting next iteration and accumulate batch entries.
    // Subset traces only cover a time window, so we store the subset-windowed s_counts
    // keyed by cell and reconstruct full-trace s_counts where available.
    // Hold onto the previous iteration's stitched activity to measure stability.
    const prevIterCounts = prevTraceCounts;
    prevTraceCounts = new Map();
    // Map cell → latest scalar results from whichever subset last processed it
    const cellScalars = new Map<
      number,
      { alpha: number; baseline: number; threshold: number; pve: number }
    >();
    // Map cell → full-length filtered trace (stitched from subset windows)
    const cellFiltered = new Map<number, Float32Array>();
    // Map cell → full-length opposite-setting counts (comparison overlay)
    const cellComparison = new Map<number, Float32Array>();
    const batchEntries: Record<string, import('./iteration-store.ts').TraceResultEntry> = {};
    for (let si = 0; si < rects.length; si++) {
      const rect = rects[si];
      for (const [cell, result] of traceResults[si]) {
        // Build a full-length s_counts array, fill the subset window
        let full = prevTraceCounts.get(cell);
        if (!full) {
          full = new Float32Array(nTp);
          prevTraceCounts.set(cell, full);
        }
        full.set(result.sCounts, rect.tStart);
        // Stitch filtered trace subset windows into full-length arrays
        if (result.filteredTrace) {
          let fullFilt = cellFiltered.get(cell);
          if (!fullFilt) {
            fullFilt = new Float32Array(nTp);
            cellFiltered.set(cell, fullFilt);
          }
          fullFilt.set(result.filteredTrace, rect.tStart);
        }
        // Stitch comparison counts subset windows into full-length arrays
        if (result.comparisonSCounts) {
          let fullCmp = cellComparison.get(cell);
          if (!fullCmp) {
            fullCmp = new Float32Array(nTp);
            cellComparison.set(cell, fullCmp);
          }
          fullCmp.set(result.comparisonSCounts, rect.tStart);
        }
        cellScalars.set(cell, {
          alpha: result.alpha,
          baseline: result.baseline,
          threshold: result.threshold,
          pve: result.pve,
        });

        // Accumulate per cell×subset result for alpha/threshold trends tracking
        batchEntries[cellSubsetKey(cell, si)] = {
          cellIndex: cell,
          subsetIdx: si,
          sCounts: result.sCounts,
          filteredTrace: result.filteredTrace,
          alpha: result.alpha,
          baseline: result.baseline,
          threshold: result.threshold,
          pve: result.pve,
          comparisonSCounts: result.comparisonSCounts,
        };
      }
    }

    // Accumulate stitched full-length results so trace viewer and distributions update correctly.
    // These use subsetIdx=-1, which cellResultLookup prefers over per-subset entries.
    for (const [cell, fullCounts] of prevTraceCounts) {
      const scalars = cellScalars.get(cell)!;
      const filteredTrace = cellFiltered.get(cell);
      batchEntries[cellSubsetKey(cell, -1)] = {
        cellIndex: cell,
        subsetIdx: -1,
        sCounts: fullCounts,
        filteredTrace,
        alpha: scalars.alpha,
        baseline: scalars.baseline,
        threshold: scalars.threshold,
        pve: scalars.pve,
        comparisonSCounts: cellComparison.get(cell),
      };
    }

    // Asymptote diagnostics computed from this iteration's activity:
    //  - stability: how much the deconvolved activity changed vs the last iteration
    //  - median PVE across the cells processed this iteration
    const traceStability = computeTraceStability(prevIterCounts, prevTraceCounts);
    const pveVals: number[] = [];
    for (const s of cellScalars.values()) pveVals.push(s.pve);
    const medianPve = pveVals.length > 0 ? median(pveVals) : null;

    // Single batched reactive update: all trace results + snapshot in one traversal
    batch(() => {
      bulkUpdateTraceResults(batchEntries);
      snapshotIteration(iter + 1, tauR, tauD);
    });

    // Capture debug trace snapshot: cell 0 from first subset that has it
    if (rects.length > 0 && traceResults[0].size > 0) {
      const debugCell = rects[0].cellStart;
      const debugResult = traceResults[0].get(debugCell);
      if (debugResult) {
        const debugTrace = extractCellTrace(
          debugCell,
          rects[0].tStart,
          rects[0].tEnd,
          data,
          isSwap,
        );
        const reconvolved = reconvolveAR2(
          debugResult.sCounts,
          tauR,
          tauD,
          fs,
          debugResult.alpha,
          debugResult.baseline,
        );
        addDebugTraceSnapshot({
          iteration: iter + 1,
          cellIndex: debugCell,
          rawTrace: debugTrace,
          sCounts: new Float32Array(debugResult.sCounts),
          reconvolved,
          alpha: debugResult.alpha,
          baseline: debugResult.baseline,
          threshold: debugResult.threshold,
          pve: debugResult.pve,
        });
      }
    }

    // Step 2: Per-subset kernel estimation (warm-started from previous iteration's kernels)
    setRunPhase('kernel-update');
    const kernelJobs = await dispatchKernelJobs(
      runPool,
      solver,
      rects,
      traceResults,
      data,
      isSwap,
      fs,
      kernelLength,
      prevKernels,
      prevBiexpResults,
    );
    assertCurrent(runId);
    checkPhase('kernel estimation', kernelJobs.outcome);
    const kernelResults = kernelJobs.results;

    if (runState() === 'stopping') break;

    if (kernelResults.length === 0) {
      break;
    }

    // Store kernels and biexp results for warm-starting next iteration.
    // dispatchKernelJobs skips subsets with no valid traces and results arrive in
    // worker-completion order, so index each result by its own subsetIdx rather
    // than by array position.
    prevKernels = new Array(rects.length);
    prevBiexpResults = new Array(rects.length);
    for (const kr of kernelResults) {
      const { hFree, subsetIdx, ...warmFields } = kr;
      prevKernels[subsetIdx] = new Float32Array(hFree);
      prevBiexpResults[subsetIdx] = warmFields;
    }

    // Step 3: Merge — median tauRise/tauDecay across subsets.
    //
    // Only subsets that actually resolved a transient get a vote. A degenerate
    // or empty fit is not a noisy measurement the median can absorb; it is not
    // a measurement at all, and letting it vote is how a preset gets reported
    // as if it had been measured. `degenerateSubsets` below still counts them
    // over every subset, so the UI badge and the export keep the full picture.
    //
    // If nothing is trustworthy there is no honest kernel to report, but the
    // loop still has to make progress and the iteration still has to be
    // recorded — so fall back to all subsets. That case is exactly
    // `degenerateSubsets === totalSubsetFits` in the snapshot, which is how a
    // reader tells a measured kernel from a manufactured one.
    setRunPhase('merge');
    const trustworthyFits = kernelResults.filter(isTrustworthyFit);
    const votingFits = trustworthyFits.length > 0 ? trustworthyFits : kernelResults;

    // Extract all scalar fields in a single pass for median computation
    const tauRises: number[] = [];
    const tauDecays: number[] = [];
    const betas: number[] = [];
    const residuals: number[] = [];
    const tauRiseFasts: number[] = [];
    const tauDecayFasts: number[] = [];
    const betaFasts: number[] = [];
    for (const r of votingFits) {
      tauRises.push(r.tauRise);
      tauDecays.push(r.tauDecay);
      betas.push(r.beta);
      residuals.push(r.residual);
      tauRiseFasts.push(r.tauRiseFast);
      tauDecayFasts.push(r.tauDecayFast);
      betaFasts.push(r.betaFast);
    }
    tauR = median(tauRises);
    tauD = median(tauDecays);

    // Convergence metric: peak-normalized RMSE between this iteration's kernel and
    // the previous one (fraction of peak, → 0 at convergence). A degenerate shape
    // (current or previous) leaves it null, which resets the stability streak.
    const shape = tauToShape(tauR, tauD);
    let kernelRmse: number | null = null;
    if (shape && prevShape) {
      kernelRmse = kernelShapeRmse(prevTauR, prevTauD, tauR, tauD, fs);
    }
    const riseUnresolved = tauR <= tauRiseFloor * RISE_FLOOR_MARGIN;
    if (shape) {
      shapeTrail.push({ tauRise: tauR, tauDecay: tauD, tPeak: shape.tPeak, fwhm: shape.fwhm });
    }

    // Record convergence history with per-subset data
    const medBeta = median(betas);
    const medResidual = median(residuals);
    const medTauRiseFast = median(tauRiseFasts);
    const medTauDecayFast = median(tauDecayFasts);
    const medBetaFast = median(betaFasts);

    // Normalized kernel-fit quality: median over subsets of 1 - SSE/||h_free||².
    // (Raw SSE scales with kernel amplitude, so it is not comparable across
    // iterations/cells; the normalized form asymptotes to a stable plateau.)
    const r2s: number[] = [];
    for (const r of votingFits) {
      const hh = sumSq(r.hFree);
      // An Empty fit carries an infinite residual, which would drag this to
      // -Infinity; a Degenerate one reports the fit quality of a curve through
      // noise. Same voting set as the taus, for the same reason.
      if (hh > 0 && Number.isFinite(r.residual)) r2s.push(1 - r.residual / hh);
    }
    const kernelFitR2 = r2s.length > 0 ? median(r2s) : null;

    // Defensibility: count subsets whose bi-exponential fit was untrustworthy
    // (no positive slow amplitude) or empty, so the UI can flag a suspect kernel.
    const degenerateSubsets = kernelResults.filter(
      (r) => r.fitMode === 'Degenerate' || r.fitMode === 'Empty',
    ).length;

    batch(() => {
      setCurrentTauRise(tauR);
      setCurrentTauDecay(tauD);
      addConvergenceSnapshot({
        iteration: iter + 1,
        tauRise: tauR,
        tauDecay: tauD,
        beta: medBeta,
        residual: medResidual,
        tauRiseFast: medTauRiseFast,
        tauDecayFast: medTauDecayFast,
        betaFast: medBetaFast,
        fs,
        tPeak: shape?.tPeak ?? null,
        fwhm: shape?.fwhm ?? null,
        kernelRmse,
        riseUnresolved,
        kernelFitR2,
        medianPve,
        traceStability,
        degenerateSubsets,
        totalSubsetFits: kernelResults.length,
        subsets: kernelResults.map((r) => ({
          subsetIdx: r.subsetIdx,
          tauRise: r.tauRise,
          tauDecay: r.tauDecay,
          beta: r.beta,
          residual: r.residual,
          tauRiseFast: r.tauRiseFast,
          tauDecayFast: r.tauDecayFast,
          betaFast: r.betaFast,
          hFree: r.hFree,
        })),
      });
    });

    // Step 4: Convergence check on kernel-shape RMSE. An iteration is "stable"
    // when the peak-normalized kernel changed less than convTol vs the previous
    // iteration; convergence is declared after `patience` consecutive stable
    // iterations, once past `minIters`. A null RMSE (degenerate current/previous
    // shape) resets the streak — it can never count as stable.
    if (kernelRmse !== null && iter + 1 >= minIters && kernelRmse < convTol) {
      if (stableCount === 0) firstStableIter = iter + 1;
      stableCount++;
    } else {
      stableCount = 0;
      firstStableIter = null;
    }
    if (shape) {
      prevShape = shape;
      prevTauR = tauR;
      prevTauD = tauD;
    }

    if (stableCount >= patience) {
      setConvergedAtIteration(firstStableIter);
      break;
    }
  }

  // Final kernel = robust central estimate of the converged tail in shape space:
  // the median of the last `selWindow` iterates' (tPeak, FWHM). This is stable
  // against the bi-exponential residual's bounce and against tau_rise <-> tau_decay
  // anti-correlation, and it operates in the non-degenerate coordinate.
  if (shapeTrail.length > 0) {
    const tail = shapeTrail.slice(-Math.max(1, selWindow));
    const medPeak = median(tail.map((s) => s.tPeak));
    const medFwhm = median(tail.map((s) => s.fwhm));
    const tau = shapeToTau(medPeak, medFwhm);
    if (tau) {
      tauR = tau.tauRise;
      tauD = tau.tauDecay;
    } else {
      // Shape pair fell outside the k-ratio lookup range — fall back to
      // tau-space medians of the same tail.
      tauR = median(tail.map((s) => s.tauRise));
      tauD = median(tail.map((s) => s.tauDecay));
    }
    setCurrentTauRise(tauR);
    setCurrentTauDecay(tauD);
  }

  // Finalization: re-run trace inference on ALL cells with converged kernel
  if (runState() !== 'stopping') {
    setRunPhase('finalization');
    setTotalSubsetTraceJobs(nCells);
    setCompletedSubsetTraceJobs(0);

    const finOutcome = await runJobs(
      runPool,
      nCells,
      (c, settle) => ({
        kind: 'trace',
        trace: extractCellTrace(c, 0, nTp, data, isSwap),
        tauRise: tauR,
        tauDecay: tauD,
        fs,
        upsampleFactor: upFactor,
        maxIters: solver.traceMaxIters,
        tol: solver.traceTol,
        hpEnabled: hpOn,
        lpEnabled: lpOn,
        lambda: sparsityLambda,
        noiseConstrained: noiseConstrainedOn,
        computeComparison,
        // Warm-start finalization from subset iteration results where available.
        // prevTraceCounts has full-length s_counts for cells that appeared in subsets.
        warmCounts: prevTraceCounts?.get(c),
        onComplete(result: TraceResult) {
          batch(() => {
            updateTraceResult(cellSubsetKey(c, -1), {
              cellIndex: c,
              subsetIdx: -1,
              sCounts: result.sCounts,
              filteredTrace: result.filteredTrace,
              alpha: result.alpha,
              baseline: result.baseline,
              threshold: result.threshold,
              pve: result.pve,
              comparisonSCounts: result.comparisonSCounts,
            });
            settle();
          });
        },
      }),
      setCompletedSubsetTraceJobs,
    );
    assertCurrent(runId);
    checkPhase('finalization', finOutcome);
  }
}

export function pauseRun(): void {
  if (runState() === 'running') {
    setRunState('paused');
  }
}

export function resumeRun(): void {
  if (runState() === 'paused') {
    setRunState('running');
    if (pauseResolver) {
      pauseResolver();
      pauseResolver = null;
    }
  }
}

/**
 * Ask the live run to finish early. Queued jobs are cancelled at once; jobs
 * already running in a worker finish first, because CaDecon's WASM solves are
 * synchronous and the worker cannot see the cancel message until they return.
 * The run then ends as 'complete' with the results gathered so far.
 */
export function stopRun(): void {
  setRunState('stopping');
  setRunPhase('idle');
  pool?.cancelAll();
  // Resolve any pending pause
  if (pauseResolver) {
    pauseResolver();
    pauseResolver = null;
  }
}

/**
 * Abandon any run and clear all iteration state. Safe at any point, including
 * while 'stopping': bumping the run generation makes the old loop unwind at its
 * next await instead of resuming against the reset state, and disposing the
 * pool settles its outstanding jobs so that await actually returns.
 */
export function resetRun(): void {
  currentRun++;
  pool?.dispose();
  pool = null;
  // Wake a paused loop so it can observe the new generation and unwind.
  const resolvePause = pauseResolver;
  pauseResolver = null;
  resolvePause?.();
  nextJobId = 0;
  resetIterationState();
}
