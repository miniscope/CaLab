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
    let errored = false;

    for (const { cell, rect, subsetIdx } of jobs) {
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
  perSubsetResults: Array<Map<number, TraceResult>>,
  data: { data: ArrayLike<number>; shape: number[] },
  isSwapped: boolean,
  fs: number,
  kernelLength: number,
): Promise<KernelResult[]> {
  return new Promise((resolve) => {
    const kernelResults: KernelResult[] = [];
    let completed = 0;
    let totalKernelJobs = 0;

    for (let si = 0; si < rects.length; si++) {
      const rect = rects[si];
      const subsetResults = perSubsetResults[si];

      const tracesFlat: number[] = [];
      const spikesFlat: number[] = [];
      const traceLengths: number[] = [];
      const alphas: number[] = [];
      const baselines: number[] = [];
      let subsetTotalSpikes = 0;

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
        subsetTotalSpikes += r.sCounts.reduce((s, v) => s + v, 0);
      }

      if (traceLengths.length === 0) {
        console.warn(
          `[CaDecon] Subset ${si}: no valid traces (all zero spikes or zero alpha). Skipping.`,
        );
        continue;
      }

      console.log(
        `[CaDecon] Subset ${si}: ${traceLengths.length} traces, ` +
          `${subsetTotalSpikes.toFixed(0)} total spikes, ` +
          `mean alpha=${(alphas.reduce((s, v) => s + v, 0) / alphas.length).toFixed(2)}, ` +
          `kernelLength=${kernelLength}`,
      );

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
          console.error(`Kernel job error (subset ${si}):`, msg);
          completed++;
          if (completed === totalKernelJobs) resolve(kernelResults);
        },
      });
    }

    if (totalKernelJobs === 0) resolve([]);
  });
}

/** Log per-subset trace inference summary. */
function logTraceResults(
  rects: SubsetRectangle[],
  perSubsetResults: Array<Map<number, TraceResult>>,
): void {
  for (let si = 0; si < rects.length; si++) {
    const subsetResults = perSubsetResults[si];
    const cells = subsetResults.size;
    if (cells === 0) {
      console.log(`[CaDecon]   Subset ${si}: 0 cells completed`);
      continue;
    }
    let totalSpikes = 0;
    let totalPve = 0;
    let totalAlpha = 0;
    let totalThreshold = 0;
    let zeroSpikeCells = 0;
    for (const r of subsetResults.values()) {
      const spikes = r.sCounts.reduce((s, v) => s + v, 0);
      totalSpikes += spikes;
      totalPve += r.pve;
      totalAlpha += r.alpha;
      totalThreshold += r.threshold;
      if (spikes === 0) zeroSpikeCells++;
    }
    console.log(
      `[CaDecon]   Subset ${si}: ${cells} cells, ` +
        `${totalSpikes.toFixed(0)} spikes (${zeroSpikeCells} cells w/ 0 spikes), ` +
        `mean PVE=${(totalPve / cells).toFixed(3)}, ` +
        `mean alpha=${(totalAlpha / cells).toFixed(2)}, ` +
        `mean threshold=${(totalThreshold / cells).toFixed(4)}`,
    );
  }
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

  console.log(
    `[CaDecon] Starting run: ${nCells} cells, ${nTp} timepoints, fs=${fs} Hz, ` +
      `upFactor=${upFactor}, ${rects.length} subsets`,
  );
  console.log(
    `[CaDecon] Initial taus: rise=${(tauR * 1000).toFixed(1)} ms, ` +
      `decay=${(tauD * 1000).toFixed(1)} ms, kernelLength=${kernelLength} samples`,
  );
  console.log(
    `[CaDecon] Convergence: tol=${convTol}, maxIter=${maxIter}, ` +
      `traceFISTA=(${TRACE_FISTA_MAX_ITERS}, ${TRACE_FISTA_TOL}), ` +
      `kernelFISTA=(${KERNEL_FISTA_MAX_ITERS}, ${KERNEL_FISTA_TOL})`,
  );

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
    console.log(
      `\n[CaDecon] === Iteration ${iter + 1} ===  ` +
        `tauR=${(tauR * 1000).toFixed(1)} ms, tauD=${(tauD * 1000).toFixed(1)} ms`,
    );

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

    console.log('[CaDecon] Trace inference complete:');
    logTraceResults(rects, traceResults);

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
        // Reconvolve using peak-normalized AR2 forward model (same as solver).
        // Raw AR2: c[t] = g1*c[t-1] + g2*c[t-2] + s[t], then divide by impulse peak.
        // recon = alpha * (c / peak) + baseline
        const dt = 1 / fs;
        const d = Math.exp(-dt / tauD);
        const r = Math.exp(-dt / tauR);
        const g1 = d + r;
        const g2 = -(d * r);
        // Compute impulse peak (same logic as Rust compute_impulse_peak)
        let impPeak = 1.0;
        {
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
        }
        const reconvolved = new Float32Array(debugTrace.length);
        const c = new Float64Array(debugTrace.length);
        for (let t = 0; t < debugTrace.length; t++) {
          c[t] =
            debugResult.sCounts[t] + (t >= 1 ? g1 * c[t - 1] : 0) + (t >= 2 ? g2 * c[t - 2] : 0);
          reconvolved[t] = debugResult.alpha * (c[t] / impPeak) + debugResult.baseline;
        }
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

    // Step 2: Per-subset kernel estimation
    console.log('[CaDecon] Dispatching kernel estimation jobs...');
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
      console.warn('[CaDecon] No kernel results — stopping.');
      break;
    }

    // Log per-subset kernel results
    console.log('[CaDecon] Kernel estimation results:');
    for (let ki = 0; ki < kernelResults.length; ki++) {
      const kr = kernelResults[ki];
      console.log(
        `[CaDecon]   Kernel ${ki}: ` +
          `tauR=${(kr.tauRise * 1000).toFixed(1)} ms, ` +
          `tauD=${(kr.tauDecay * 1000).toFixed(1)} ms, ` +
          `beta=${kr.beta.toFixed(4)}, residual=${kr.residual.toFixed(6)}`,
      );
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
      subsets: kernelResults.map((r) => ({
        tauRise: r.tauRise,
        tauDecay: r.tauDecay,
        beta: r.beta,
        residual: r.residual,
      })),
    });

    // Step 4: Convergence check
    const relChangeTauR = Math.abs(tauR - prevTauR) / (prevTauR + 1e-20);
    const relChangeTauD = Math.abs(tauD - prevTauD) / (prevTauD + 1e-20);
    const maxRelChange = Math.max(relChangeTauR, relChangeTauD);
    console.log(
      `[CaDecon] Merge: tauR=${(tauR * 1000).toFixed(1)} ms, ` +
        `tauD=${(tauD * 1000).toFixed(1)} ms  ` +
        `(change: tauR=${(relChangeTauR * 100).toFixed(1)}%, ` +
        `tauD=${(relChangeTauD * 100).toFixed(1)}%, ` +
        `max=${(maxRelChange * 100).toFixed(1)}% vs tol=${(convTol * 100).toFixed(1)}%)`,
    );

    if (iter > 0 && maxRelChange < convTol) {
      console.log(`[CaDecon] Converged at iteration ${iter + 1}.`);
      break;
    }
  }

  // Finalization: re-run trace inference on ALL cells with converged kernel
  if (runState() !== 'stopping') {
    console.log(
      `\n[CaDecon] === Finalization ===  ` +
        `${nCells} cells with tauR=${(tauR * 1000).toFixed(1)} ms, ` +
        `tauD=${(tauD * 1000).toFixed(1)} ms`,
    );
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
    console.log('[CaDecon] Finalization complete.');
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
