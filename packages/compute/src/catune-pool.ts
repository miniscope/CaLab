import type { PoolWorkerOutbound, SolverParams, WarmStartStrategy } from '@calab/core';
import type { BaseJob, MessageRouter } from './worker-pool.ts';
import { createWorkerPool, type WorkerPool } from './worker-pool.ts';

export interface CaTunePoolJob extends BaseJob {
  trace: Float32Array;
  params: SolverParams;
  warmState: Uint8Array | null;
  warmStrategy: WarmStartStrategy;
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
}

const caTuneRouter: MessageRouter<CaTunePoolJob, PoolWorkerOutbound> = {
  isReady(msg) {
    return msg.type === 'ready';
  },

  getJobId(msg) {
    if ('jobId' in msg) return msg.jobId;
    return undefined;
  },

  routeMessage(job, msg, finish) {
    switch (msg.type) {
      case 'intermediate':
        job.onIntermediate(msg.solution, msg.reconvolution, msg.iteration);
        break;
      case 'complete':
        finish();
        job.onComplete(
          msg.solution,
          msg.reconvolution,
          msg.state,
          msg.iterations,
          msg.converged,
          msg.filteredTrace,
        );
        break;
      case 'cancelled':
        finish();
        job.onCancelled();
        break;
      case 'error':
        finish();
        job.onError(msg.message);
        break;
    }
  },

  buildDispatch(job) {
    const traceCopy = new Float32Array(job.trace);
    const transfer: Transferable[] = [traceCopy.buffer];
    const warmCopy = job.warmState ? new Uint8Array(job.warmState) : null;
    if (warmCopy) transfer.push(warmCopy.buffer);

    return [
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
    ];
  },
};

export function createCaTuneWorkerPool(
  createWorker: () => Worker,
  poolSize?: number,
): WorkerPool<CaTunePoolJob> {
  return createWorkerPool<CaTunePoolJob, PoolWorkerOutbound>(createWorker, caTuneRouter, poolSize);
}
