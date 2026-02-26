// CaDecon pool worker: WASM-backed InDeCa solver with cooperative cancellation.
// Handles trace-job (spike inference) and kernel-job (kernel estimation + biexp fit).

import {
  initWasm,
  indeca_solve_trace,
  indeca_estimate_kernel,
  indeca_fit_biexponential,
} from '@calab/core';
import type { CaDeconWorkerInbound, CaDeconWorkerOutbound } from './cadecon-types.ts';

let cancelled = false;
const EMPTY_F32 = new Float32Array(0);

const workerScope = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

function post(msg: CaDeconWorkerOutbound, transfer: Transferable[] = []): void {
  workerScope.postMessage(msg, transfer);
}

function handleTraceJob(req: Extract<CaDeconWorkerInbound, { type: 'trace-job' }>): void {
  try {
    cancelled = false;

    const jsResult = indeca_solve_trace(
      req.trace,
      req.tauRise,
      req.tauDecay,
      req.fs,
      req.upsampleFactor,
      req.maxIters,
      req.tol,
      req.hpEnabled,
      req.lpEnabled,
      req.warmCounts ?? EMPTY_F32,
    ) as {
      s_counts: number[];
      filtered_trace: number[] | null;
      alpha: number;
      baseline: number;
      threshold: number;
      pve: number;
      iterations: number;
      converged: boolean;
    };

    if (cancelled) {
      post({ type: 'cancelled', jobId: req.jobId });
      return;
    }

    const sCounts = new Float32Array(jsResult.s_counts);
    const filteredTrace = jsResult.filtered_trace
      ? new Float32Array(jsResult.filtered_trace)
      : undefined;
    const transfers: ArrayBuffer[] = [sCounts.buffer];
    if (filteredTrace) transfers.push(filteredTrace.buffer);
    post(
      {
        type: 'trace-complete',
        jobId: req.jobId,
        result: {
          sCounts,
          filteredTrace,
          alpha: jsResult.alpha,
          baseline: jsResult.baseline,
          threshold: jsResult.threshold,
          pve: jsResult.pve,
          iterations: jsResult.iterations,
          converged: jsResult.converged,
        },
      },
      transfers,
    );
  } catch (err) {
    post({ type: 'error', jobId: req.jobId, message: String(err) });
  }
}

function handleKernelJob(req: Extract<CaDeconWorkerInbound, { type: 'kernel-job' }>): void {
  try {
    cancelled = false;

    // Step 1: Free-form kernel estimation
    const hFree = indeca_estimate_kernel(
      req.tracesFlat,
      req.spikesFlat,
      req.traceLengths,
      req.alphas,
      req.baselines,
      req.kernelLength,
      req.maxIters,
      req.tol,
      req.warmKernel ?? EMPTY_F32,
    );

    if (cancelled) {
      post({ type: 'cancelled', jobId: req.jobId });
      return;
    }

    const hFreeArr = new Float32Array(hFree);

    // Step 2: Bi-exponential fit
    const biexpJs = indeca_fit_biexponential(hFreeArr, req.fs, req.refine) as {
      tau_rise: number;
      tau_decay: number;
      beta: number;
      residual: number;
    };

    post(
      {
        type: 'kernel-complete',
        jobId: req.jobId,
        result: {
          hFree: hFreeArr,
          tauRise: biexpJs.tau_rise,
          tauDecay: biexpJs.tau_decay,
          beta: biexpJs.beta,
          residual: biexpJs.residual,
        },
      },
      [hFreeArr.buffer],
    );
  } catch (err) {
    post({ type: 'error', jobId: req.jobId, message: String(err) });
  }
}

onmessage = (e: MessageEvent<CaDeconWorkerInbound>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'cancel':
      cancelled = true;
      break;
    case 'trace-job':
      handleTraceJob(msg);
      break;
    case 'kernel-job':
      handleKernelJob(msg);
      break;
  }
};

// Initialize WASM on startup
initWasm()
  .then(() => {
    post({ type: 'ready' });
  })
  .catch((err) => {
    console.error('CaDecon WASM initialization failed:', err);
  });
