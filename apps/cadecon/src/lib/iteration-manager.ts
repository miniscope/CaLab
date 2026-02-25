// Iteration Manager: orchestrates the InDeCa iterative deconvolution loop.
//
// Loop per iteration:
//   1. Per-trace inference on subset cells (parallel trace-jobs)
//   2. Per-subset kernel estimation (parallel kernel-jobs)
//   3. Merge: median tauRise/tauDecay across subsets
//   4. Convergence check
//   5. On convergence/max iters: finalization pass on ALL cells

import type { WorkerPool } from '@calab/compute';
import type { CaDeconPoolJob } from './cadecon-pool.ts';
import { createCaDeconWorkerPool } from './cadecon-pool.ts';
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
  updateTraceResult,
  resetIterationState,
} from './iteration-store.ts';
import {
  tauRiseInit,
  tauDecayInit,
  upsampleFactor,
  maxIterations,
  convergenceTol,
} from './algorithm-store.ts';
import {
  parsedData,
  samplingRate,
  numCells,
  numTimepoints,
  swapped,
  effectiveShape,
} from './data-store.ts';
import { subsetRectangles } from './subset-store.ts';
import type { SubsetRectangle } from './subset-store.ts';
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

// --- Dispatch helpers ---

/** Run trace inference for all cells in all subsets. Returns per-cell results indexed by cell. */
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
): Promise<Map<number, TraceResult[]>> {
  return new Promise((resolve) => {
    // Collect all (cell, rect) pairs
    const jobs: { cell: number; rect: SubsetRectangle }[] = [];
    for (const rect of rects) {
      for (let c = rect.cellStart; c < rect.cellEnd; c++) {
        jobs.push({ cell: c, rect });
      }
    }

    setTotalSubsetTraceJobs(jobs.length);
    setCompletedSubsetTraceJobs(0);

    if (jobs.length === 0) {
      resolve(new Map());
      return;
    }

    const results = new Map<number, TraceResult[]>();
    let completed = 0;
    let errored = false;

    for (const { cell, rect } of jobs) {
      const trace = extractCellTrace(cell, rect.tStart, rect.tEnd, data, isSwapped);
      const jobId = nextJobId++;

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
        onComplete(result: TraceResult) {
          if (!results.has(cell)) results.set(cell, []);
          results.get(cell)!.push(result);
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
          if (!errored) {
            errored = true;
            console.error('Trace job error:', msg);
          }
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
  traceResults: Map<number, TraceResult[]>,
  data: { data: ArrayLike<number>; shape: number[] },
  isSwapped: boolean,
  fs: number,
  kernelLength: number,
): Promise<KernelResult[]> {
  return new Promise((resolve) => {
    const kernelResults: KernelResult[] = [];
    let completed = 0;
    let totalKernelJobs = 0;

    for (const rect of rects) {
      // Collect traces and results for this subset
      const tracesFlat: number[] = [];
      const spikesFlat: number[] = [];
      const traceLengths: number[] = [];
      const alphas: number[] = [];
      const baselines: number[] = [];

      for (let c = rect.cellStart; c < rect.cellEnd; c++) {
        const cellResults = traceResults.get(c);
        if (!cellResults || cellResults.length === 0) continue;

        // Use the first result for this cell (from this or any subset)
        const r = cellResults[0];
        if (r.alpha === 0 || r.sCounts.every((v) => v === 0)) continue;

        const trace = extractCellTrace(c, rect.tStart, rect.tEnd, data, isSwapped);
        tracesFlat.push(...trace);
        spikesFlat.push(...r.sCounts.slice(0, trace.length));
        traceLengths.push(trace.length);
        alphas.push(r.alpha);
        baselines.push(r.baseline);
      }

      if (traceLengths.length === 0) {
        // No valid traces in this subset — skip
        continue;
      }

      totalKernelJobs++;
      const jobId = nextJobId++;

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
        onComplete(result: KernelResult) {
          kernelResults.push(result);
          completed++;
          if (completed === totalKernelJobs) resolve(kernelResults);
        },
        onCancelled() {
          completed++;
          if (completed === totalKernelJobs) resolve(kernelResults);
        },
        onError(msg: string) {
          console.error('Kernel job error:', msg);
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

  // Kernel length: ~2x tau_decay in samples
  const kernelLength = Math.max(10, Math.ceil(2.0 * tauD * fs));

  // Create pool
  pool = createCaDeconWorkerPool();
  setRunState('running');
  setCurrentIteration(0);

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

    // Step 1: Per-trace inference
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
    );

    if (runState() === 'stopping') break;

    // Step 2: Per-subset kernel estimation
    const kernelResults = await dispatchKernelJobs(
      rects,
      traceResults,
      data,
      isSwap,
      fs,
      kernelLength,
    );

    if (runState() === 'stopping') break;

    if (kernelResults.length === 0) {
      // No kernel results — stop
      break;
    }

    // Step 3: Merge — median tauRise/tauDecay across subsets
    const prevTauR = tauR;
    const prevTauD = tauD;
    tauR = median(kernelResults.map((r) => r.tauRise));
    tauD = median(kernelResults.map((r) => r.tauDecay));

    setCurrentTauRise(tauR);
    setCurrentTauDecay(tauD);

    // Record convergence history
    const medBeta = median(kernelResults.map((r) => r.beta));
    const medResidual = median(kernelResults.map((r) => r.residual));
    addConvergenceSnapshot({
      iteration: iter + 1,
      tauRise: tauR,
      tauDecay: tauD,
      beta: medBeta,
      residual: medResidual,
    });

    // Step 4: Convergence check
    const relChangeTauR = Math.abs(tauR - prevTauR) / (prevTauR + 1e-20);
    const relChangeTauD = Math.abs(tauD - prevTauD) / (prevTauD + 1e-20);
    if (iter > 0 && Math.max(relChangeTauR, relChangeTauD) < convTol) {
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
