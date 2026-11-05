// Short-lived worker pool for the dataset overview pass (protocol in
// workers/catune-types.ts). Separate from the solver pool so the overview never
// touches solver state or the GPU backend.

import {
  createWorkerPool,
  type BaseJob,
  type MessageRouter,
  type WorkerPool,
} from '@calab/compute';
import type { CellOverview } from '@calab/core';
import type { OverviewWorkerOutbound } from '../workers/catune-types.ts';

export interface OverviewPoolJob extends BaseJob {
  tracesFlat: Float32Array;
  nCells: number;
  nTimepoints: number;
  fs: number;
  minSeparationSamples: number;
  isDff: boolean;
  baselineBins: number;
  onComplete(cells: CellOverview[]): void;
}

const overviewRouter: MessageRouter<OverviewPoolJob, OverviewWorkerOutbound> = {
  isReady: (msg) => msg.type === 'ready',
  getJobId: (msg) => ('jobId' in msg ? msg.jobId : undefined),
  routeMessage(job, msg, finish) {
    if (msg.type === 'overview-complete') {
      finish();
      job.onComplete(msg.cells);
    } else if (msg.type === 'error') {
      finish();
      job.onError(msg.message);
    }
  },
  buildDispatch(job) {
    return [
      {
        type: 'overview-job',
        jobId: job.jobId,
        tracesFlat: job.tracesFlat,
        nCells: job.nCells,
        nTimepoints: job.nTimepoints,
        fs: job.fs,
        minSeparationSamples: job.minSeparationSamples,
        isDff: job.isDff,
        baselineBins: job.baselineBins,
      },
      [job.tracesFlat.buffer],
    ];
  },
};

export function createOverviewWorkerPool(
  poolSize?: number,
  options?: { onFatal?(message: string): void },
): WorkerPool<OverviewPoolJob> {
  return createWorkerPool<OverviewPoolJob, OverviewWorkerOutbound>(
    () => new Worker(new URL('../workers/overview-worker.ts', import.meta.url), { type: 'module' }),
    overviewRouter,
    poolSize,
    options,
  );
}
