// Pool worker: self-contained WASM solver with cooperative cancellation.
// Uses raw postMessage (not Comlink) so the event loop can process
// cancel messages between solver batches via MessageChannel yields.

import { initWasm, Solver } from '@calab/core';
import type { PoolWorkerInbound, PoolWorkerOutbound } from '@calab/core';

const INTERMEDIATE_INTERVAL_MS = 100;
const BATCH_SIZE = 15;

// MessageChannel yields in <1ms vs setTimeout(0)'s ~4ms minimum timer resolution.
const yieldChannel = new MessageChannel();
function yieldToMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    yieldChannel.port2.onmessage = () => resolve();
    yieldChannel.port1.postMessage(null);
  });
}

let solver: Solver | null = null;
let cancelled = false;

// Worker-scoped postMessage (avoid Window overload confusion)
const workerScope = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

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
    solver.set_trace(req.trace);
    solver.set_filter_enabled(req.params.filterEnabled);

    // Apply bandpass filter before warm-start (filter modifies the trace itself)
    let filteredTrace: Float32Array | undefined;
    if (req.params.filterEnabled) {
      solver.apply_filter();
      filteredTrace = solver.get_trace();
    }

    // Warm-start: load cached state; reset momentum if kernel changed
    if (req.warmState && req.warmStrategy !== 'cold') {
      solver.load_state(req.warmState);
      if (req.warmStrategy === 'warm-no-momentum') solver.reset_momentum();
    }

    let lastIntermediateTime = performance.now();
    const startIter = solver.iteration_count();
    const quantumLimit = req.maxIterations ?? Infinity;

    while (
      !solver.converged() &&
      !cancelled &&
      solver.iteration_count() - startIter < quantumLimit
    ) {
      solver.step_batch(BATCH_SIZE);

      // Post intermediate result at ~100ms intervals
      const now = performance.now();
      if (now - lastIntermediateTime >= INTERMEDIATE_INTERVAL_MS) {
        const sol = solver.get_solution();
        const reconv = solver.get_reconvolution_with_baseline();
        const transfer: Transferable[] = [sol.buffer, reconv.buffer];
        post(
          {
            type: 'intermediate',
            jobId: req.jobId,
            solution: sol,
            reconvolution: reconv,
            iteration: solver.iteration_count(),
          },
          transfer,
        );
        lastIntermediateTime = now;
      }

      // Yield to event loop so cancel messages can be processed
      await yieldToMacrotask();
    }

    if (cancelled) {
      post({ type: 'cancelled', jobId: req.jobId });
      return;
    }

    // Final result
    const solution = solver.get_solution();
    const reconvolution = solver.get_reconvolution_with_baseline();
    const state = solver.export_state();

    const ftCopy = filteredTrace ? new Float32Array(filteredTrace) : undefined;
    const transfer: Transferable[] = [solution.buffer, reconvolution.buffer, state.buffer];
    if (ftCopy) transfer.push(ftCopy.buffer);

    post(
      {
        type: 'complete',
        jobId: req.jobId,
        solution,
        reconvolution,
        state,
        iterations: solver.iteration_count(),
        converged: solver.converged(),
        filteredTrace: ftCopy,
      },
      transfer,
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
initWasm()
  .then(() => {
    solver = new Solver();
    post({ type: 'ready' });
  })
  .catch((err) => {
    console.error('WASM initialization failed:', err);
  });
