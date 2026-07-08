// Iteration Manager: orchestrates the InDeCa iterative deconvolution loop.
//
// Loop per iteration:
//   1. Per-trace inference on subset cells (parallel trace-jobs)
//   2. Per-subset kernel estimation (parallel kernel-jobs)
//   3. Merge: median tauRise/tauDecay across subsets
//   4. Convergence check
//   5. On convergence/max iters: finalization pass on ALL cells

import { batch } from 'solid-js';
import { tauToShape, shapeToTau, type WorkerPool } from '@calab/compute';
import { createCaDeconWorkerPool, type CaDeconPoolJob } from './cadecon-pool.ts';
import type {
  TraceResult,
  KernelResult,
  SeedTraceResult,
  WarmBiexp,
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
import { dataIndex } from './data-utils.ts';
import { median } from './math-utils.ts';
import { reconvolveAR2 } from './reconvolve.ts';

// Per-trace and per-kernel FISTA solver parameters are configurable via
// algorithm-store (traceFistaMaxIters/Tol, kernelFistaMaxIters/Tol,
// kernelSmoothLambda) so they are overridable and recorded with the run.
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

/** Denominator guard for relative shape deltas (peak/FWHM are in seconds). */
const SHAPE_EPS = 1e-9;
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
 * ||s_new - s_old|| / (||s_new|| + eps). Returns null if no comparable cells.
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
    if (normNew < STABILITY_MIN_ACTIVITY) continue;
    let diff = 0;
    for (let i = 0; i < sNew.length; i++) {
      const d = sNew[i] - sOld[i];
      diff += d * d;
    }
    deltas.push(Math.sqrt(diff) / (normNew + STABILITY_EPS));
  }
  return deltas.length > 0 ? median(deltas) : null;
}

let pool: WorkerPool<CaDeconPoolJob> | null = null;
let nextJobId = 0;
let pauseResolver: (() => void) | null = null;

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

/**
 * Run trace inference for all cells in all subsets.
 * Returns an array (one per subset) of Map<cellIndex, TraceResult>.
 */
function dispatchTraceJobs(
  rects: SubsetRectangle[],
  data: { data: ArrayLike<number>; shape: number[] },
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
  prevResults?: Map<number, Float32Array>,
): Promise<Array<Map<number, TraceResult>>> {
  return new Promise((resolve) => {
    const jobs: { cell: number; rect: SubsetRectangle; subsetIdx: number }[] = [];
    for (let si = 0; si < rects.length; si++) {
      const rect = rects[si];
      for (let c = rect.cellStart; c < rect.cellEnd; c++) {
        jobs.push({ cell: c, rect, subsetIdx: si });
      }
    }

    setTotalSubsetTraceJobs(jobs.length);
    setCompletedSubsetTraceJobs(0);

    if (jobs.length === 0) {
      resolve(rects.map(() => new Map()));
      return;
    }

    const results: Array<Map<number, TraceResult>> = rects.map(() => new Map());
    let completed = 0;

    for (const { cell, rect, subsetIdx } of jobs) {
      const trace = extractCellTrace(cell, rect.tStart, rect.tEnd, data, isSwapped);
      const jobId = nextJobId++;

      // Warm-start: extract the relevant segment of previous s_counts for this subset window.
      // Previous s_counts cover the full trace; we need just [tStart, tEnd).
      let warmCounts: Float32Array | undefined;
      const prevCounts = prevResults?.get(cell);
      if (prevCounts && prevCounts.length > 0) {
        warmCounts = prevCounts.subarray(rect.tStart, rect.tEnd);
      }

      pool!.dispatch({
        jobId,
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
        warmCounts,
        onComplete(result: TraceResult) {
          results[subsetIdx].set(cell, result);
          completed++;
          setCompletedSubsetTraceJobs(completed);
          if (completed === jobs.length) resolve(results);
        },
        onCancelled() {
          completed++;
          setCompletedSubsetTraceJobs(completed);
          if (completed === jobs.length) resolve(results);
        },
        onError() {
          completed++;
          setCompletedSubsetTraceJobs(completed);
          if (completed === jobs.length) resolve(results);
        },
      });
    }
  });
}

/** Run kernel estimation for each subset. Returns per-subset kernel results. */
function dispatchKernelJobs(
  rects: SubsetRectangle[],
  perSubsetResults: Array<Map<number, TraceResult>>,
  data: { data: ArrayLike<number>; shape: number[] },
  isSwapped: boolean,
  fs: number,
  kernelLength: number,
  prevKernels?: Float32Array[],
  prevBiexpResults?: WarmBiexp[],
): Promise<KernelJobResult[]> {
  return new Promise((resolve) => {
    const kernelResults: KernelJobResult[] = [];
    let completed = 0;
    let totalKernelJobs = 0;

    for (let si = 0; si < rects.length; si++) {
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

      if (validCells.length === 0) {
        continue;
      }

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

      totalKernelJobs++;
      const jobId = nextJobId++;

      // Warm-start: use previous iteration's kernel and biexp result for this subset
      const warmKernel = prevKernels?.[si];
      const warmBiexp = prevBiexpResults?.[si];

      pool!.dispatch({
        jobId,
        kind: 'kernel',
        tracesFlat,
        spikesFlat,
        traceLengths,
        alphas,
        baselines,
        kernelLength,
        fs,
        maxIters: kernelFistaMaxIters(),
        tol: kernelFistaTol(),
        refine: true,
        smoothLambda: kernelSmoothLambda(),
        biexpSkip: BIEXP_FIT_SKIP,
        warmKernel,
        warmBiexp,
        onComplete(result: KernelResult) {
          kernelResults.push({ ...result, subsetIdx: si });
          completed++;
          if (completed === totalKernelJobs) resolve(kernelResults);
        },
        onCancelled() {
          completed++;
          if (completed === totalKernelJobs) resolve(kernelResults);
        },
        onError() {
          completed++;
          if (completed === totalKernelJobs) resolve(kernelResults);
        },
      });
    }

    if (totalKernelJobs === 0) resolve([]);
  });
}

// --- Seed trace dispatch (parallel, Rust WASM via worker pool) ---

/**
 * Dispatch seed-trace jobs for all cells in all subsets.
 * Each worker runs Rust peak detection (find_seed_spikes) — no kernel needed.
 * Returns the same shape as dispatchTraceJobs so it feeds directly into dispatchKernelJobs.
 */
function dispatchSeedTraceJobs(
  rects: SubsetRectangle[],
  data: { data: ArrayLike<number>; shape: number[] },
  isSwapped: boolean,
  fs: number,
): Promise<Array<Map<number, TraceResult>>> {
  return new Promise((resolve) => {
    const jobs: { cell: number; rect: SubsetRectangle; subsetIdx: number }[] = [];
    for (let si = 0; si < rects.length; si++) {
      const rect = rects[si];
      for (let c = rect.cellStart; c < rect.cellEnd; c++) {
        jobs.push({ cell: c, rect, subsetIdx: si });
      }
    }

    setTotalSubsetTraceJobs(jobs.length);
    setCompletedSubsetTraceJobs(0);

    if (jobs.length === 0) {
      resolve(rects.map(() => new Map()));
      return;
    }

    const results: Array<Map<number, TraceResult>> = rects.map(() => new Map());
    let completed = 0;

    for (const { cell, rect, subsetIdx } of jobs) {
      const trace = extractCellTrace(cell, rect.tStart, rect.tEnd, data, isSwapped);
      const jobId = nextJobId++;

      pool!.dispatch({
        jobId,
        kind: 'seed-trace',
        trace,
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
          completed++;
          setCompletedSubsetTraceJobs(completed);
          if (completed === jobs.length) resolve(results);
        },
        onCancelled() {
          completed++;
          setCompletedSubsetTraceJobs(completed);
          if (completed === jobs.length) resolve(results);
        },
        onError(msg: string) {
          console.warn('[CaDecon] seed-trace error:', msg);
          completed++;
          setCompletedSubsetTraceJobs(completed);
          if (completed === jobs.length) resolve(results);
        },
      });
    }
  });
}

// --- Main Loop ---

export async function startRun(): Promise<void> {
  const data = parsedData();
  const fs = samplingRate();
  const shape = effectiveShape();
  if (!data || !fs || !shape) return;

  // Snapshot parameters — tau values are auto-detected by the seed phase below;
  // these fallbacks are only used if the seed phase yields zero kernel results.
  const TAU_RISE_FALLBACK = 0.2;
  const TAU_DECAY_FALLBACK = 1.0;
  let tauR = TAU_RISE_FALLBACK;
  let tauD = TAU_DECAY_FALLBACK;
  const upFactor = upsampleFactor();
  const maxIter = maxIterations();
  // Shape-space convergence controls (see algorithm-store / CONVERGENCE_RANGES).
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

  // Create pool
  pool = createCaDeconWorkerPool();
  setRunState('running');
  setCurrentIteration(0);

  // Seed phase: detect peaks in raw traces → kernel estimation → bootstrap taus.
  // Uses the same subset rectangles and dispatchKernelJobs as the iterative loop,
  // but replaces FISTA trace inference with Rust peak detection (no kernel needed).
  setRunPhase('inference');
  const seedTraceResults = await dispatchSeedTraceJobs(rects, data, isSwap, fs);

  // Use a generous kernel length for the seed phase (~1.5s) since tauD is unknown
  const seedKernelLength = Math.max(10, Math.min(200, Math.ceil(1.5 * fs)));

  setRunPhase('kernel-update');
  const seedKernelResults = await dispatchKernelJobs(
    rects,
    seedTraceResults,
    data,
    isSwap,
    fs,
    seedKernelLength,
  );

  if (seedKernelResults.length > 0) {
    const seedTauRises: number[] = new Array(seedKernelResults.length);
    const seedTauDecays: number[] = new Array(seedKernelResults.length);
    for (let i = 0; i < seedKernelResults.length; i++) {
      seedTauRises[i] = seedKernelResults[i].tauRise;
      seedTauDecays[i] = seedKernelResults[i].tauDecay;
    }
    tauR = median(seedTauRises);
    tauD = median(seedTauDecays);
    setCurrentTauRise(tauR);
    setCurrentTauDecay(tauD);
    console.log(
      `[CaDecon] Auto-init kernel: τ_rise=${(tauR * 1000).toFixed(1)}ms, τ_decay=${(tauD * 1000).toFixed(1)}ms`,
    );
  }

  if (runState() === 'stopping') {
    setRunPhase('idle');
    setRunState('complete');
    return;
  }

  // Kernel length: 5x tau_decay in samples (matches CaTune's computeKernel convention)
  const kernelLength = Math.max(10, Math.ceil(5.0 * tauD * fs));

  // Warm-start state carried between iterations
  let prevTraceCounts: Map<number, Float32Array> | undefined;
  let prevKernels: Float32Array[] | undefined;
  let prevBiexpResults: WarmBiexp[] | undefined;

  // Shape-space convergence tracking. (tau_rise, tau_decay) is a degenerate
  // convergence coordinate (tau_rise <-> tau_decay thrash inflates the delta), so
  // we test convergence in (tPeak, FWHM) space: an iteration is "stable" when both
  // move less than convTol relative to the previous one, and we declare
  // convergence after `patience` consecutive stable iterations. The final kernel
  // is the median of the last `selWindow` iterates' shapes — not the argmin of the
  // (bouncy, unreliable) bi-exponential residual, which the old revert used.
  let prevShape = tauToShape(tauR, tauD);
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
      residual: 0,
      tauRiseFast: 0,
      tauDecayFast: 0,
      betaFast: 0,
      fs,
      tPeak: prevShape?.tPeak ?? null,
      fwhm: prevShape?.fwhm ?? null,
      shapeDelta: null,
      riseUnresolved: false,
      kernelFitR2: null,
      medianPve: null,
      traceStability: null,
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
      if (runState() === 'stopping') break;
    }

    setCurrentIteration(iter + 1);

    // Step 1: Per-trace inference (warm-started from previous iteration's s_counts)
    setRunPhase('inference');
    const traceResults = await dispatchTraceJobs(
      rects,
      data,
      isSwap,
      tauR,
      tauD,
      fs,
      upFactor,
      traceFistaMaxIters(),
      traceFistaTol(),
      hpOn,
      lpOn,
      sparsityLambda,
      prevTraceCounts,
    );

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
    const kernelResults = await dispatchKernelJobs(
      rects,
      traceResults,
      data,
      isSwap,
      fs,
      kernelLength,
      prevKernels,
      prevBiexpResults,
    );

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

    // Step 3: Merge — median tauRise/tauDecay across subsets
    setRunPhase('merge');
    // Extract all scalar fields in a single pass for median computation
    const tauRises: number[] = [];
    const tauDecays: number[] = [];
    const betas: number[] = [];
    const residuals: number[] = [];
    const tauRiseFasts: number[] = [];
    const tauDecayFasts: number[] = [];
    const betaFasts: number[] = [];
    for (const r of kernelResults) {
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

    // Convergence coordinate: kernel shape (peak time + FWHM).
    const shape = tauToShape(tauR, tauD);
    let shapeDelta: number | null = null;
    if (shape && prevShape) {
      const dPeak = Math.abs(shape.tPeak - prevShape.tPeak) / (prevShape.tPeak + SHAPE_EPS);
      const dFwhm = Math.abs(shape.fwhm - prevShape.fwhm) / (prevShape.fwhm + SHAPE_EPS);
      shapeDelta = Math.max(dPeak, dFwhm);
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
    for (const r of kernelResults) {
      const hh = sumSq(r.hFree);
      if (hh > 0) r2s.push(1 - r.residual / hh);
    }
    const kernelFitR2 = r2s.length > 0 ? median(r2s) : null;
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
        shapeDelta,
        riseUnresolved,
        kernelFitR2,
        medianPve,
        traceStability,
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

    // Step 4: Convergence check in shape space. An iteration is "stable" when
    // both peak time and FWHM change less than convTol; convergence is declared
    // after `patience` consecutive stable iterations, once past `minIters`. A
    // degenerate (null) shape resets the streak — it can never count as stable.
    if (shape && shapeDelta !== null && iter + 1 >= minIters && shapeDelta < convTol) {
      if (stableCount === 0) firstStableIter = iter + 1;
      stableCount++;
    } else {
      stableCount = 0;
      firstStableIter = null;
    }
    if (shape) prevShape = shape;

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
    let finCompleted = 0;

    await new Promise<void>((resolve) => {
      if (nCells === 0) {
        resolve();
        return;
      }

      for (let c = 0; c < nCells; c++) {
        const trace = extractCellTrace(c, 0, nTp, data, isSwap);
        const jobId = nextJobId++;

        // Warm-start finalization from subset iteration results where available.
        // prevTraceCounts has full-length s_counts for cells that appeared in subsets.
        const warmCounts = prevTraceCounts?.get(c);

        pool!.dispatch({
          jobId,
          kind: 'trace',
          trace,
          tauRise: tauR,
          tauDecay: tauD,
          fs,
          upsampleFactor: upFactor,
          maxIters: traceFistaMaxIters(),
          tol: traceFistaTol(),
          hpEnabled: hpOn,
          lpEnabled: lpOn,
          lambda: sparsityLambda,
          warmCounts,
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
              });
              finCompleted++;
              setCompletedSubsetTraceJobs(finCompleted);
            });
            if (finCompleted === nCells) resolve();
          },
          onCancelled() {
            finCompleted++;
            setCompletedSubsetTraceJobs(finCompleted);
            if (finCompleted === nCells) resolve();
          },
          onError() {
            finCompleted++;
            setCompletedSubsetTraceJobs(finCompleted);
            if (finCompleted === nCells) resolve();
          },
        });
      }
    });
  }

  setRunPhase('idle');
  setRunState('complete');
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

export function resetRun(): void {
  pool?.dispose();
  pool = null;
  pauseResolver = null;
  nextJobId = 0;
  resetIterationState();
}
