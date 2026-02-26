// Iteration Manager: orchestrates the InDeCa iterative deconvolution loop.
//
// Loop per iteration:
//   1. Per-trace inference on subset cells (parallel trace-jobs)
//   2. Per-subset kernel estimation (parallel kernel-jobs)
//   3. Merge: median tauRise/tauDecay across subsets
//   4. Convergence check
//   5. On convergence/max iters: finalization pass on ALL cells

import type { WorkerPool } from '@calab/compute';
import { createCaDeconWorkerPool, type CaDeconPoolJob } from './cadecon-pool.ts';
import type { TraceResult, KernelResult } from '../workers/cadecon-types.ts';
import {
  runState,
  setRunState,
  setCurrentIteration,
  setTotalSubsetTraceJobs,
  setCompletedSubsetTraceJobs,
  setCurrentTauRise,
  setCurrentTauDecay,
  addConvergenceSnapshot,
  addDebugTraceSnapshot,
  updateTraceResult,
  resetIterationState,
} from './iteration-store.ts';
import {
  tauRiseInit,
  tauDecayInit,
  upsampleFactor,
  maxIterations,
  convergenceTol,
  bandpassEnabled,
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

/** Per-trace FISTA solver parameters (shared between subset and finalization passes). */
const TRACE_FISTA_MAX_ITERS = 500;
const TRACE_FISTA_TOL = 1e-4;

/** Per-subset kernel estimation solver parameters. */
const KERNEL_FISTA_MAX_ITERS = 200;
const KERNEL_FISTA_TOL = 1e-4;

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

/** Compute median of a numeric array. */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Reconvolve a spike train through the peak-normalized AR2 forward model.
 * Mirrors the Rust BandedAR2 convolution: c[t] = g1*c[t-1] + g2*c[t-2] + s[t],
 * then normalize by impulse peak so recon = alpha * (c / peak) + baseline.
 */
function reconvolveAR2(
  sCounts: Float32Array,
  tauR: number,
  tauD: number,
  fs: number,
  alpha: number,
  baseline: number,
): Float32Array {
  const dt = 1 / fs;
  const d = Math.exp(-dt / tauD);
  const r = Math.exp(-dt / tauR);
  const g1 = d + r;
  const g2 = -(d * r);

  // Compute impulse peak (same logic as Rust compute_impulse_peak)
  let impPeak = 1.0;
  let cPrev2 = 0;
  let cPrev1 = 1;
  const maxSteps = Math.ceil(5 * tauD * fs) + 10;
  for (let i = 1; i < maxSteps; i++) {
    const cv = g1 * cPrev1 + g2 * cPrev2;
    if (cv > impPeak) impPeak = cv;
    if (cv < impPeak * 0.95) break;
    cPrev2 = cPrev1;
    cPrev1 = cv;
  }

  const n = sCounts.length;
  const reconvolved = new Float32Array(n);
  const c = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    c[t] = sCounts[t] + (t >= 1 ? g1 * c[t - 1] : 0) + (t >= 2 ? g2 * c[t - 2] : 0);
    reconvolved[t] = alpha * (c[t] / impPeak) + baseline;
  }
  return reconvolved;
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
  filterEnabled: boolean,
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
        filterEnabled,
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
): Promise<KernelResult[]> {
  return new Promise((resolve) => {
    const kernelResults: KernelResult[] = [];
    let completed = 0;
    let totalKernelJobs = 0;
    // Track which subset index maps to which dispatched job index for warm kernel lookup
    const jobSubsetIndices: number[] = [];

    for (let si = 0; si < rects.length; si++) {
      const rect = rects[si];
      const subsetResults = perSubsetResults[si];

      const tracesFlat: number[] = [];
      const spikesFlat: number[] = [];
      const traceLengths: number[] = [];
      const alphas: number[] = [];
      const baselines: number[] = [];

      for (let c = rect.cellStart; c < rect.cellEnd; c++) {
        const r = subsetResults.get(c);
        if (!r) continue;
        if (r.alpha === 0 || r.sCounts.every((v) => v === 0)) continue;

        const trace = extractCellTrace(c, rect.tStart, rect.tEnd, data, isSwapped);
        tracesFlat.push(...trace);
        spikesFlat.push(...r.sCounts);
        traceLengths.push(trace.length);
        alphas.push(r.alpha);
        baselines.push(r.baseline);
      }

      if (traceLengths.length === 0) {
        continue;
      }

      jobSubsetIndices.push(si);
      totalKernelJobs++;
      const jobId = nextJobId++;

      // Warm-start: use previous iteration's kernel for this subset
      const warmKernel = prevKernels?.[si];

      pool!.dispatch({
        jobId,
        kind: 'kernel',
        tracesFlat: new Float32Array(tracesFlat),
        spikesFlat: new Float32Array(spikesFlat),
        traceLengths: new Uint32Array(traceLengths),
        alphas: new Float64Array(alphas),
        baselines: new Float64Array(baselines),
        kernelLength,
        fs,
        maxIters: KERNEL_FISTA_MAX_ITERS,
        tol: KERNEL_FISTA_TOL,
        refine: true,
        warmKernel,
        onComplete(result: KernelResult) {
          kernelResults.push(result);
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

// --- Main Loop ---

export async function startRun(): Promise<void> {
  const data = parsedData();
  const fs = samplingRate();
  const shape = effectiveShape();
  if (!data || !fs || !shape) return;

  // Snapshot parameters
  let tauR = tauRiseInit();
  let tauD = tauDecayInit();
  const upFactor = upsampleFactor();
  const maxIter = maxIterations();
  const convTol = convergenceTol();
  const rects = subsetRectangles();
  const isSwap = swapped();
  const nCells = numCells();
  const nTp = numTimepoints();
  const filterOn = bandpassEnabled();

  // Kernel length: 5x tau_decay in samples (matches CaTune's computeKernel convention)
  const kernelLength = Math.max(10, Math.ceil(5.0 * tauD * fs));

  // Create pool
  pool = createCaDeconWorkerPool();
  setRunState('running');
  setCurrentIteration(0);

  // Warm-start state carried between iterations
  let prevTraceCounts: Map<number, Float32Array> | undefined;
  let prevKernels: Float32Array[] | undefined;

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
    const traceResults = await dispatchTraceJobs(
      rects,
      data,
      isSwap,
      tauR,
      tauD,
      fs,
      upFactor,
      TRACE_FISTA_MAX_ITERS,
      TRACE_FISTA_TOL,
      filterOn,
      prevTraceCounts,
    );

    if (runState() === 'stopping') break;

    // Collect s_counts for warm-starting next iteration.
    // Subset traces only cover a time window, so we store the subset-windowed s_counts
    // keyed by cell and reconstruct full-trace s_counts where available.
    prevTraceCounts = new Map();
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
      }
    }

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
    const kernelResults = await dispatchKernelJobs(
      rects,
      traceResults,
      data,
      isSwap,
      fs,
      kernelLength,
      prevKernels,
    );

    if (runState() === 'stopping') break;

    if (kernelResults.length === 0) {
      break;
    }

    // Store kernels for warm-starting next iteration.
    // dispatchKernelJobs skips subsets with no valid traces, so kernelResults
    // may have fewer entries than rects. Map them back by replaying the skip logic.
    prevKernels = new Array(rects.length);
    {
      let ki = 0;
      for (let si = 0; si < rects.length; si++) {
        const subsetResults = traceResults[si];
        let hasValid = false;
        for (const [, r] of subsetResults) {
          if (r.alpha !== 0 && !r.sCounts.every((v) => v === 0)) {
            hasValid = true;
            break;
          }
        }
        if (hasValid && ki < kernelResults.length) {
          prevKernels[si] = new Float32Array(kernelResults[ki].hFree);
          ki++;
        }
      }
    }

    // Step 3: Merge — median tauRise/tauDecay across subsets
    const prevTauR = tauR;
    const prevTauD = tauD;
    tauR = median(kernelResults.map((r) => r.tauRise));
    tauD = median(kernelResults.map((r) => r.tauDecay));

    setCurrentTauRise(tauR);
    setCurrentTauDecay(tauD);

    // Record convergence history with per-subset data
    const medBeta = median(kernelResults.map((r) => r.beta));
    const medResidual = median(kernelResults.map((r) => r.residual));
    addConvergenceSnapshot({
      iteration: iter + 1,
      tauRise: tauR,
      tauDecay: tauD,
      beta: medBeta,
      residual: medResidual,
      fs,
      subsets: kernelResults.map((r) => ({
        tauRise: r.tauRise,
        tauDecay: r.tauDecay,
        beta: r.beta,
        residual: r.residual,
        hFree: r.hFree,
      })),
    });

    // Step 4: Convergence check
    const relChangeTauR = Math.abs(tauR - prevTauR) / (prevTauR + 1e-20);
    const relChangeTauD = Math.abs(tauD - prevTauD) / (prevTauD + 1e-20);
    const maxRelChange = Math.max(relChangeTauR, relChangeTauD);
    if (iter > 0 && maxRelChange < convTol) {
      break;
    }
  }

  // Finalization: re-run trace inference on ALL cells with converged kernel
  if (runState() !== 'stopping') {
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
          maxIters: TRACE_FISTA_MAX_ITERS,
          tol: TRACE_FISTA_TOL,
          filterEnabled: filterOn,
          warmCounts,
          onComplete(result: TraceResult) {
            updateTraceResult(c, {
              sCounts: result.sCounts,
              alpha: result.alpha,
              baseline: result.baseline,
              pve: result.pve,
            });
            finCompleted++;
            setCompletedSubsetTraceJobs(finCompleted);
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
