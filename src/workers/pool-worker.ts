// Pool worker: self-contained WASM solver with cooperative cancellation.
// Uses raw postMessage (not Comlink) so the event loop can process
// cancel messages between solver batches via setTimeout(0) yields.

import init, { Solver } from '../../wasm/catune-solver/pkg/catune_solver';
import type { PoolWorkerInbound, PoolWorkerOutbound } from '../lib/solver-types';

const INTERMEDIATE_INTERVAL_MS = 100;
const BATCH_SIZE = 10;

let solver: Solver | null = null;
let cancelled = false;

// Worker-scoped postMessage (avoid Window overload confusion)
const workerScope = globalThis as unknown as { postMessage(msg: unknown, transfer?: Transferable[]): void };

function post(msg: PoolWorkerOutbound, transfer?: Transferable[]): void {
  if (transfer) {
    workerScope.postMessage(msg, transfer);
  } else {
    workerScope.postMessage(msg);
  }
}

async function handleSolve(req: Extract<PoolWorkerInbound, { type: 'solve' }>): Promise<void> {
  if (!solver) {
    post({ type: 'error', jobId: req.jobId, message: 'Solver not initialized' });
    return;
  }

  cancelled = false;

  try {
    // Configure solver
    solver.set_params(req.params.tauRise, req.params.tauDecay, req.params.lambda, req.params.fs);
    solver.set_trace(new Float32Array(req.trace));

    // Warm-start handling
    if (req.warmStrategy === 'warm' && req.warmState) {
      solver.load_state(req.warmState);
    } else if (req.warmStrategy === 'warm-no-momentum' && req.warmState) {
      solver.load_state(req.warmState);
      solver.reset_momentum();
    }
    // 'cold': set_trace already zeroed the solution

    let lastIntermediateTime = performance.now();

    while (!solver.converged() && !cancelled) {
      solver.step_batch(BATCH_SIZE);

      // Post intermediate result at ~100ms intervals
      const now = performance.now();
      if (now - lastIntermediateTime >= INTERMEDIATE_INTERVAL_MS) {
        const sol = solver.get_solution();
        const reconv = solver.get_reconvolution();
        post(
          {
            type: 'intermediate',
            jobId: req.jobId,
            solution: sol,
            reconvolution: reconv,
            iteration: solver.iteration_count(),
          },
          [sol.buffer, reconv.buffer],
        );
        lastIntermediateTime = now;
      }

      // Yield to event loop so cancel messages can be processed
      await new Promise<void>(r => setTimeout(r, 0));
    }

    if (cancelled) {
      post({ type: 'cancelled', jobId: req.jobId });
      return;
    }

    // Final result
    const solution = solver.get_solution();
    const reconvolution = solver.get_reconvolution();
    const state = solver.export_state();

    post(
      {
        type: 'complete',
        jobId: req.jobId,
        solution,
        reconvolution,
        state,
        iterations: solver.iteration_count(),
        converged: solver.converged(),
      },
      [solution.buffer, reconvolution.buffer, state.buffer],
    );
  } catch (err) {
    post({ type: 'error', jobId: req.jobId, message: String(err) });
  }
}

// Message handler
onmessage = (e: MessageEvent<PoolWorkerInbound>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (msg.type === 'solve') {
    handleSolve(msg).catch((err) => {
      post({ type: 'error', jobId: msg.jobId, message: String(err) });
    });
  }
};

// Initialize WASM on startup
init().then(() => {
  solver = new Solver();
  post({ type: 'ready' });
}).catch((err) => {
  console.error('WASM initialization failed:', err);
});
