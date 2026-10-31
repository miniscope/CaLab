// Dev-only helper worker for the WebGPU backend (see lib/solver-backend.ts).
//
// - 'prep': the preprocessing half of pool-worker.ts, in the same order
//   (set_conv_mode, set_params, set_trace, set_filter_enabled, optional
//   apply_filter, subtract_baseline, get_trace), returning the working trace
//   the GPU solves.
// - 'reference': the same preprocessing, the GPU's warm start if it had one
//   (load_state, plus reset_momentum for 'warm-no-momentum', exactly as the
//   pool worker and the GPU treat it), then step_batch to convergence with no
//   getter calls in between. pool-worker.ts polls
//   get_reconvolution_with_baseline every 100 ms, which writes the solver's
//   baseline (CODEBASE-REVIEW-2026-10 §1.2), so its results depend on timing;
//   this reference does not, so it is the fair one to compare the GPU with.

import { initWasm, Solver } from '@calab/core/wasm';
import type { SolverParams } from '@calab/core';
import type { GpuPrepInbound, GpuPrepOutbound } from './gpu-prep-types.ts';

const REFERENCE_BATCH = 50;

let solver: Solver | null = null;

const workerScope = globalThis as unknown as {
  postMessage(msg: GpuPrepOutbound, transfer?: Transferable[]): void;
};

function preprocess(s: Solver, trace: Float32Array, params: SolverParams): Float32Array {
  s.set_conv_mode(params.convMode === 'banded' ? 1 : 0);
  s.set_params(params.tauRise, params.tauDecay, params.lambda, params.fs);
  s.set_trace(trace);
  s.set_filter_enabled(params.filterEnabled);
  if (params.filterEnabled) s.apply_filter();
  s.subtract_baseline();
  return s.get_trace();
}

onmessage = (e: MessageEvent<GpuPrepInbound>) => {
  const msg = e.data;
  if (!solver) {
    workerScope.postMessage({ type: 'error', id: msg.id, message: 'Solver not initialized' });
    return;
  }
  try {
    if (msg.type === 'prep') {
      const working = preprocess(solver, msg.trace, msg.params);
      workerScope.postMessage({ type: 'prepped', id: msg.id, working }, [working.buffer]);
      return;
    }
    const t0 = performance.now();
    const working = preprocess(solver, msg.trace, msg.params);
    if (msg.warmState && msg.warmStrategy !== 'cold') {
      solver.load_state(msg.warmState);
      if (msg.warmStrategy === 'warm-no-momentum') solver.reset_momentum();
    }
    const startIter = solver.iteration_count();
    const t1 = performance.now();
    while (!solver.converged() && solver.iteration_count() - startIter < msg.maxIters) {
      solver.step_batch(REFERENCE_BATCH);
    }
    const solveMs = performance.now() - t1;
    const solution = solver.get_solution();
    workerScope.postMessage(
      {
        type: 'referenced',
        id: msg.id,
        working,
        solution,
        iterations: solver.iteration_count(),
        iterationsRun: solver.iteration_count() - startIter,
        converged: solver.converged(),
        ms: performance.now() - t0,
        solveMs,
      },
      [working.buffer, solution.buffer],
    );
  } catch (err) {
    workerScope.postMessage({ type: 'error', id: msg.id, message: String(err) });
  }
};

initWasm()
  .then(() => {
    solver = new Solver();
    workerScope.postMessage({ type: 'ready' });
  })
  .catch((err) => workerScope.postMessage({ type: 'init-error', message: String(err) }));
