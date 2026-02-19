// Generic worker pool manager.
// Dispatches jobs to idle workers, queues when all busy,
// supports per-job cancellation and bulk cancelAll.

import type { SolverParams, WarmStartStrategy, PoolWorkerOutbound } from './solver-types.ts';

export interface PoolJob {
  jobId: number;
  trace: Float32Array;
  params: SolverParams;
  warmState: Uint8Array | null;
  warmStrategy: WarmStartStrategy;
  /** Dynamic priority callback — called at drain time for fresh ordering.
   *  Lower number = higher priority. 0 = active cell, 1 = visible, 2 = off-screen. */
  getPriority?: () => number;
  maxIterations?: number;
  onIntermediate(solution: Float32Array, reconvolution: Float32Array, iteration: number): void;
  onComplete(
    solution: Float32Array,
    reconvolution: Float32Array,
    state: Uint8Array,
    iterations: number,
    converged: boolean,
    filteredTrace?: Float32Array,
  ): void;
  onCancelled(): void;
  onError(message: string): void;
}

type WorkerState = { status: 'init' } | { status: 'idle' } | { status: 'busy'; jobId: number };

interface PoolEntry {
  worker: Worker;
  state: WorkerState;
}

export interface WorkerPool {
  dispatch(job: PoolJob): void;
  cancel(jobId: number): void;
  cancelAll(): void;
  dispose(): void;
}

export function createWorkerPool(poolSize?: number): WorkerPool {
  const size = poolSize ?? Math.min(navigator.hardwareConcurrency ?? 4, 4);
  const entries: PoolEntry[] = [];
  const queue: PoolJob[] = [];
  // Map jobId → PoolJob for in-flight jobs (needed for routing messages)
  const inFlightJobs = new Map<number, PoolJob>();
  let disposed = false;

  // Create workers
  for (let i = 0; i < size; i++) {
    const worker = new Worker(new URL('../workers/pool-worker.ts', import.meta.url), {
      type: 'module',
    });

    const entry: PoolEntry = { worker, state: { status: 'init' } };
    entries.push(entry);

    worker.onmessage = (e: MessageEvent<PoolWorkerOutbound>) => {
      handleWorkerMessage(entry, e.data);
    };
  }

  function handleWorkerMessage(entry: PoolEntry, msg: PoolWorkerOutbound): void {
    if (msg.type === 'ready') {
      entry.state = { status: 'idle' };
      // Drain queue now that this worker is ready
      drainQueue();
      return;
    }

    if (msg.type === 'intermediate') {
      const job = inFlightJobs.get(msg.jobId);
      if (job) {
        job.onIntermediate(msg.solution, msg.reconvolution, msg.iteration);
      }
      return;
    }

    if (msg.type === 'complete') {
      const job = inFlightJobs.get(msg.jobId);
      inFlightJobs.delete(msg.jobId);
      entry.state = { status: 'idle' };
      if (job) {
        job.onComplete(
          msg.solution,
          msg.reconvolution,
          msg.state,
          msg.iterations,
          msg.converged,
          msg.filteredTrace,
        );
      }
      drainQueue();
      return;
    }

    if (msg.type === 'cancelled') {
      const job = inFlightJobs.get(msg.jobId);
      inFlightJobs.delete(msg.jobId);
      entry.state = { status: 'idle' };
      if (job) {
        job.onCancelled();
      }
      drainQueue();
      return;
    }

    if (msg.type === 'error') {
      const job = inFlightJobs.get(msg.jobId);
      inFlightJobs.delete(msg.jobId);
      entry.state = { status: 'idle' };
      if (job) {
        job.onError(msg.message);
      }
      drainQueue();
      return;
    }
  }

  function findIdleWorker(): PoolEntry | undefined {
    return entries.find((e) => e.state.status === 'idle');
  }

  function dispatchToWorker(entry: PoolEntry, job: PoolJob): void {
    entry.state = { status: 'busy', jobId: job.jobId };
    inFlightJobs.set(job.jobId, job);

    // Copy buffers for transfer (avoids detaching caller's buffers)
    const traceCopy = new Float32Array(job.trace);
    const transfer: Transferable[] = [traceCopy.buffer];
    const warmCopy = job.warmState ? new Uint8Array(job.warmState) : null;
    if (warmCopy) transfer.push(warmCopy.buffer);

    entry.worker.postMessage(
      {
        type: 'solve',
        jobId: job.jobId,
        trace: traceCopy,
        params: job.params,
        warmState: warmCopy,
        warmStrategy: job.warmStrategy,
        maxIterations: job.maxIterations,
      },
      transfer,
    );
  }

  function jobPriority(job: PoolJob): number {
    return job.getPriority?.() ?? 1;
  }

  function drainQueue(): void {
    if (queue.length > 1) {
      queue.sort((a, b) => jobPriority(a) - jobPriority(b));
    }
    while (queue.length > 0) {
      const idle = findIdleWorker();
      if (!idle) break;
      const job = queue.shift()!;
      dispatchToWorker(idle, job);
    }
  }

  function dispatch(job: PoolJob): void {
    if (disposed) return;
    queue.push(job);
    drainQueue();
  }

  function cancel(jobId: number): void {
    // Check queue first — if queued, just remove and call onCancelled
    const qIdx = queue.findIndex((j) => j.jobId === jobId);
    if (qIdx !== -1) {
      const [job] = queue.splice(qIdx, 1);
      job.onCancelled();
      return;
    }

    // If in-flight, send cancel to the worker
    for (const entry of entries) {
      if (entry.state.status === 'busy' && entry.state.jobId === jobId) {
        entry.worker.postMessage({ type: 'cancel' });
        return;
      }
    }
  }

  function cancelAll(): void {
    // Cancel all queued jobs
    while (queue.length > 0) {
      const job = queue.shift()!;
      inFlightJobs.delete(job.jobId);
      job.onCancelled();
    }

    // Cancel all in-flight jobs
    for (const entry of entries) {
      if (entry.state.status === 'busy') {
        entry.worker.postMessage({ type: 'cancel' });
      }
    }
  }

  function dispose(): void {
    disposed = true;
    cancelAll();
    for (const entry of entries) {
      entry.worker.terminate();
    }
    entries.length = 0;
    inFlightJobs.clear();
  }

  return { dispatch, cancel, cancelAll, dispose };
}
