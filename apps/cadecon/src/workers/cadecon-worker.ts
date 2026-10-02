// CaDecon pool worker: WASM-backed InDeCa solver.
// Handles trace-job (spike inference), kernel-job (kernel estimation + biexp fit)
// and seed-trace-job (peak detection).
//
// Cancellation is NOT cooperative mid-job: each handler makes synchronous WASM
// calls, so a `cancel` message is not processed until the current job returns.
// Each handler resets `cancelled` on entry, so its `if (cancelled)` checks can
// never fire: a cancel sent for an in-flight job is effectively a no-op and
// that job delivers its normal result. Only queued jobs are cancelled (by the
// pool, without reaching the worker). Stopping a run therefore waits for
// in-flight jobs; resetRun / pool.dispose() terminates the workers outright.

import {
  initWasm,
  indeca_solve_trace,
  indeca_estimate_kernel,
  indeca_fit_biexponential,
  seed_trace,
} from '@calab/core';
import type { CaDeconWorkerInbound, CaDeconWorkerOutbound, FitMode } from './cadecon-types.ts';

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
      req.lambda,
      req.noiseConstrained,
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

    // Teaching/impact overlay: also solve with the OPPOSITE sparsity setting.
    // Same trace + kernel; only the threshold-selection stage differs.
    let comparisonSCounts: Float32Array | undefined;
    if (req.computeComparison) {
      const cmp = indeca_solve_trace(
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
        req.lambda,
        !req.noiseConstrained,
      ) as { s_counts: number[] };
      comparisonSCounts = new Float32Array(cmp.s_counts);
      transfers.push(comparisonSCounts.buffer as ArrayBuffer);
    }

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
          comparisonSCounts,
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
      req.smoothLambda,
    );

    if (cancelled) {
      post({ type: 'cancelled', jobId: req.jobId });
      return;
    }

    const hFreeArr = new Float32Array(hFree);

    // Step 2: Bi-exponential fit (with optional warm-start)
    const w = req.warmBiexp;
    const biexpJs = indeca_fit_biexponential(
      hFreeArr,
      req.fs,
      req.refine,
      req.biexpSkip,
      w?.tauRise ?? 0,
      w?.tauDecay ?? 0,
      w?.tauRiseFast ?? 0,
      w?.tauDecayFast ?? 0,
      w?.beta ?? 0,
      w?.betaFast ?? 0,
      w?.residual ?? 0,
      w != null,
    ) as {
      tau_rise: number;
      tau_decay: number;
      beta: number;
      residual: number;
      tau_rise_fast: number;
      tau_decay_fast: number;
      beta_fast: number;
      fit_mode: string;
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
          tauRiseFast: biexpJs.tau_rise_fast,
          tauDecayFast: biexpJs.tau_decay_fast,
          betaFast: biexpJs.beta_fast,
          fitMode: biexpJs.fit_mode as FitMode,
        },
      },
      [hFreeArr.buffer],
    );
  } catch (err) {
    post({ type: 'error', jobId: req.jobId, message: String(err) });
  }
}

function handleSeedTraceJob(req: Extract<CaDeconWorkerInbound, { type: 'seed-trace-job' }>): void {
  try {
    cancelled = false;

    const jsResult = seed_trace(req.trace, req.fs) as {
      s_counts: number[];
      alpha: number;
      baseline: number;
    };

    if (cancelled) {
      post({ type: 'cancelled', jobId: req.jobId });
      return;
    }

    const sCounts = new Float32Array(jsResult.s_counts);
    post(
      {
        type: 'seed-trace-complete',
        jobId: req.jobId,
        result: { sCounts, alpha: jsResult.alpha, baseline: jsResult.baseline },
      },
      [sCounts.buffer],
    );
  } catch (err) {
    post({ type: 'error', jobId: req.jobId, message: String(err) });
  }
}

// Each handler catches its own errors; the outer try/catch is a backstop so a
// job always gets a terminal message instead of leaving the pool waiting.
onmessage = (e: MessageEvent<CaDeconWorkerInbound>) => {
  const msg = e.data;
  try {
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
      case 'seed-trace-job':
        handleSeedTraceJob(msg);
        break;
    }
  } catch (err) {
    if (msg.type !== 'cancel') post({ type: 'error', jobId: msg.jobId, message: String(err) });
  }
};

// Initialize WASM on startup
initWasm()
  .then(() => {
    post({ type: 'ready' });
  })
  .catch((err) => {
    console.error('CaDecon WASM initialization failed:', err);
    // Pool-level protocol message (WorkerInitErrorMessage in @calab/compute):
    // lets the pool fail this worker's jobs instead of queueing them forever.
    workerScope.postMessage({ type: 'init-error', message: String(err) });
  });
