import type { BaseJob, MessageRouter } from '@calab/compute';
import { createWorkerPool, type WorkerPool } from '@calab/compute';
import type { CaDeconWorkerOutbound, TraceResult, KernelResult } from '../workers/cadecon-types.ts';

// --- Pool Job Types ---

interface TraceJobFields {
  kind: 'trace';
  trace: Float32Array;
  tauRise: number;
  tauDecay: number;
  fs: number;
  upsampleFactor: number;
  maxIters: number;
  tol: number;
  onComplete(result: TraceResult): void;
}

interface KernelJobFields {
  kind: 'kernel';
  tracesFlat: Float32Array;
  spikesFlat: Float32Array;
  traceLengths: Uint32Array;
  alphas: Float64Array;
  baselines: Float64Array;
  kernelLength: number;
  fs: number;
  maxIters: number;
  tol: number;
  refine: boolean;
  onComplete(result: KernelResult): void;
}

export type CaDeconPoolJob = BaseJob & (TraceJobFields | KernelJobFields);

// --- Message Router ---

const caDeconRouter: MessageRouter<CaDeconPoolJob, CaDeconWorkerOutbound> = {
  isReady(msg) {
    return msg.type === 'ready';
  },

  getJobId(msg) {
    if ('jobId' in msg) return msg.jobId;
    return undefined;
  },

  routeMessage(job, msg, finish) {
    switch (msg.type) {
      case 'trace-complete':
        finish();
        if (job.kind === 'trace') job.onComplete(msg.result);
        break;
      case 'kernel-complete':
        finish();
        if (job.kind === 'kernel') job.onComplete(msg.result);
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
    if (job.kind === 'trace') {
      const traceCopy = new Float32Array(job.trace);
      return [
        {
          type: 'trace-job',
          jobId: job.jobId,
          trace: traceCopy,
          tauRise: job.tauRise,
          tauDecay: job.tauDecay,
          fs: job.fs,
          upsampleFactor: job.upsampleFactor,
          maxIters: job.maxIters,
          tol: job.tol,
        },
        [traceCopy.buffer],
      ];
    } else {
      const tracesCopy = new Float32Array(job.tracesFlat);
      const spikesCopy = new Float32Array(job.spikesFlat);
      const lengthsCopy = new Uint32Array(job.traceLengths);
      const alphasCopy = new Float64Array(job.alphas);
      const baselinesCopy = new Float64Array(job.baselines);
      return [
        {
          type: 'kernel-job',
          jobId: job.jobId,
          tracesFlat: tracesCopy,
          spikesFlat: spikesCopy,
          traceLengths: lengthsCopy,
          alphas: alphasCopy,
          baselines: baselinesCopy,
          kernelLength: job.kernelLength,
          fs: job.fs,
          maxIters: job.maxIters,
          tol: job.tol,
          refine: job.refine,
        },
        [
          tracesCopy.buffer,
          spikesCopy.buffer,
          lengthsCopy.buffer,
          alphasCopy.buffer,
          baselinesCopy.buffer,
        ],
      ];
    }
  },
};

export function createCaDeconWorkerPool(poolSize?: number): WorkerPool<CaDeconPoolJob> {
  return createWorkerPool<CaDeconPoolJob, CaDeconWorkerOutbound>(
    () => new Worker(new URL('../workers/cadecon-worker.ts', import.meta.url), { type: 'module' }),
    caDeconRouter,
    poolSize,
  );
}
