// Generic worker pool manager.
// Dispatches jobs to idle workers, queues when all busy,
// supports per-job cancellation and bulk cancelAll.
//
// Failure handling (every dispatched job is guaranteed to settle exactly once
// via onComplete-equivalent routing, onCancelled, or onError):
//   - A worker that posts `{ type: 'init-error' }`, or raises `onerror` /
//     `onmessageerror`, is terminated. Its in-flight job (if any) fails via
//     `onError`.
//   - A worker that fails before ever reporting ready (WASM fetch/compile
//     failure) is marked dead and NOT respawned: init failures are
//     deterministic, so a replacement would fail the same way. A worker that
//     fails after it was ready is replaced once per pool slot; a second
//     failure in the same slot marks it dead.
//   - When every worker is dead the pool is fatal: all queued jobs fail via
//     `onError`, later dispatches fail immediately, and `onFatal` fires once.
//   - `dispose()` settles every queued and in-flight job via `onCancelled`;
//     dispatches after dispose are cancelled immediately.

import { resolveWorkerCount } from './worker-sizing.ts';

export interface BaseJob {
  jobId: number;
  getPriority?(): number;
  onCancelled(): void;
  onError(msg: string): void;
}

export interface MessageRouter<TJob extends BaseJob, TOut> {
  isReady(msg: TOut): boolean;
  getJobId(msg: TOut): number | undefined;
  routeMessage(job: TJob, msg: TOut, finish: () => void): void;
  buildDispatch(job: TJob): [unknown, Transferable[]];
}

/**
 * Pool-level protocol message a worker posts when its startup (e.g. WASM
 * init) fails. Handled by the pool itself, before the app router sees it, so
 * app-specific outbound types don't need to model it.
 */
export interface WorkerInitErrorMessage {
  type: 'init-error';
  message: string;
}

function isInitErrorMessage(msg: unknown): msg is WorkerInitErrorMessage {
  return (
    typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'init-error'
  );
}

export interface WorkerPoolOptions {
  /**
   * Called once when every worker in the pool has died (e.g. WASM failed to
   * initialize in all of them). By then every queued job has already failed
   * via `onError`, and any later `dispatch` fails immediately.
   */
  onFatal?(message: string): void;
}

type WorkerState =
  { status: 'init' } | { status: 'idle' } | { status: 'busy'; jobId: number } | { status: 'dead' };

interface PoolEntry {
  worker: Worker;
  state: WorkerState;
  /** Whether this slot has already used its one replacement. */
  respawned: boolean;
}

export interface WorkerPool<TJob extends BaseJob = BaseJob> {
  readonly size: number;
  dispatch(job: TJob): void;
  cancel(jobId: number): void;
  cancelAll(): void;
  dispose(): void;
}

export function createWorkerPool<TJob extends BaseJob, TOut>(
  createWorker: () => Worker,
  router: MessageRouter<TJob, TOut>,
  poolSize?: number,
  options: WorkerPoolOptions = {},
): WorkerPool<TJob> {
  const size = poolSize ?? resolveWorkerCount();
  const entries: PoolEntry[] = [];
  const queue: TJob[] = [];
  const inFlightJobs = new Map<number, TJob>();
  let disposed = false;
  let fatalError: string | null = null;

  function attach(entry: PoolEntry): void {
    const worker = entry.worker;
    // Handlers check identity so a terminated worker's late events are ignored.
    worker.onmessage = (e: MessageEvent<TOut>) => {
      if (entry.worker !== worker) return;
      handleWorkerMessage(entry, e.data);
    };
    worker.onerror = (e: ErrorEvent) => {
      if (entry.worker !== worker) return;
      failWorker(entry, `Worker error: ${e.message || 'unknown error'}`);
    };
    worker.onmessageerror = () => {
      if (entry.worker !== worker) return;
      failWorker(entry, 'Worker message could not be deserialized');
    };
  }

  for (let i = 0; i < size; i++) {
    const entry: PoolEntry = {
      worker: createWorker(),
      state: { status: 'init' },
      respawned: false,
    };
    entries.push(entry);
    attach(entry);
  }

  function finishJob(entry: PoolEntry, jobId: number): TJob | undefined {
    const job = inFlightJobs.get(jobId);
    inFlightJobs.delete(jobId);
    entry.state = { status: 'idle' };
    return job;
  }

  function handleWorkerMessage(entry: PoolEntry, msg: TOut): void {
    if (disposed || entry.state.status === 'dead') return;

    if (isInitErrorMessage(msg)) {
      failWorker(entry, `Worker failed to initialize: ${msg.message}`);
      return;
    }

    if (router.isReady(msg)) {
      entry.state = { status: 'idle' };
      drainQueue();
      return;
    }

    const jobId = router.getJobId(msg);
    if (jobId === undefined) return;

    const job = inFlightJobs.get(jobId);
    if (!job) return;

    router.routeMessage(job, msg, () => {
      finishJob(entry, jobId);
      drainQueue();
    });
  }

  /** Terminate a failed worker, fail its in-flight job, and replace or bury it. */
  function failWorker(entry: PoolEntry, message: string): void {
    if (disposed || entry.state.status === 'dead') return;

    const prev = entry.state;
    entry.worker.terminate();

    if (prev.status !== 'init' && !entry.respawned) {
      entry.respawned = true;
      entry.worker = createWorker();
      entry.state = { status: 'init' };
      attach(entry);
    } else {
      entry.state = { status: 'dead' };
    }

    if (prev.status === 'busy') {
      const job = inFlightJobs.get(prev.jobId);
      inFlightJobs.delete(prev.jobId);
      job?.onError(message);
    }

    if (!disposed && fatalError === null && entries.every((e) => e.state.status === 'dead')) {
      fatalError = message;
      const failed = queue.splice(0, queue.length);
      for (const job of failed) job.onError(message);
      options.onFatal?.(message);
    }
  }

  function findIdleWorker(): PoolEntry | undefined {
    return entries.find((e) => e.state.status === 'idle');
  }

  function dispatchToWorker(entry: PoolEntry, job: TJob): void {
    entry.state = { status: 'busy', jobId: job.jobId };
    inFlightJobs.set(job.jobId, job);

    const [payload, transfer] = router.buildDispatch(job);
    entry.worker.postMessage(payload, transfer);
  }

  function jobPriority(job: TJob): number {
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

  function dispatch(job: TJob): void {
    if (disposed) {
      job.onCancelled();
      return;
    }
    if (fatalError !== null) {
      job.onError(fatalError);
      return;
    }
    queue.push(job);
    drainQueue();
  }

  function cancel(jobId: number): void {
    const qIdx = queue.findIndex((j) => j.jobId === jobId);
    if (qIdx !== -1) {
      const [job] = queue.splice(qIdx, 1);
      job.onCancelled();
      return;
    }

    for (const entry of entries) {
      if (entry.state.status === 'busy' && entry.state.jobId === jobId) {
        entry.worker.postMessage({ type: 'cancel' });
        return;
      }
    }
  }

  function cancelAll(): void {
    while (queue.length > 0) {
      const job = queue.shift()!;
      job.onCancelled();
    }

    for (const entry of entries) {
      if (entry.state.status === 'busy') {
        entry.worker.postMessage({ type: 'cancel' });
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Collect before notifying so callbacks that re-dispatch see a disposed
    // pool (and are cancelled immediately) rather than mutating these lists.
    const pending = [...queue, ...inFlightJobs.values()];
    queue.length = 0;
    inFlightJobs.clear();
    for (const entry of entries) {
      entry.worker.terminate();
    }
    entries.length = 0;
    for (const job of pending) job.onCancelled();
  }

  return { size, dispatch, cancel, cancelAll, dispose };
}
