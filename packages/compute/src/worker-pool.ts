// Generic worker pool manager.
// Dispatches jobs to idle workers, queues when all busy,
// supports per-job cancellation and bulk cancelAll.

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

type WorkerState = { status: 'init' } | { status: 'idle' } | { status: 'busy'; jobId: number };

interface PoolEntry {
  worker: Worker;
  state: WorkerState;
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
): WorkerPool<TJob> {
  const size = poolSize ?? resolveWorkerCount();
  const entries: PoolEntry[] = [];
  const queue: TJob[] = [];
  const inFlightJobs = new Map<number, TJob>();
  let disposed = false;

  for (let i = 0; i < size; i++) {
    const worker = createWorker();

    const entry: PoolEntry = { worker, state: { status: 'init' } };
    entries.push(entry);

    worker.onmessage = (e: MessageEvent<TOut>) => {
      handleWorkerMessage(entry, e.data);
    };
  }

  function finishJob(entry: PoolEntry, jobId: number): TJob | undefined {
    const job = inFlightJobs.get(jobId);
    inFlightJobs.delete(jobId);
    entry.state = { status: 'idle' };
    return job;
  }

  function handleWorkerMessage(entry: PoolEntry, msg: TOut): void {
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
    if (disposed) return;
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
    disposed = true;
    cancelAll();
    for (const entry of entries) {
      entry.worker.terminate();
    }
    entries.length = 0;
    inFlightJobs.clear();
  }

  return { size, dispatch, cancel, cancelAll, dispose };
}
