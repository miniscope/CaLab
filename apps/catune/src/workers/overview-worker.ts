// Overview worker: runs the model-free `overview_cell` pass (shared SNR metric,
// events, baseline, clipping) over a chunk of cells. Display only; nothing here
// feeds the solver. CaDecon's equivalent job lives in its cadecon-worker.ts.

import { initWasm, overview_cell } from '@calab/core/wasm';
import { cellOverviewFromJson, type CellOverviewJson } from '@calab/core';
import type { OverviewWorkerInbound, OverviewWorkerOutbound } from './catune-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

function post(msg: OverviewWorkerOutbound): void {
  workerScope.postMessage(msg);
}

function handleJob(req: OverviewWorkerInbound): void {
  try {
    const cells = [];
    for (let c = 0; c < req.nCells; c++) {
      const trace = req.tracesFlat.subarray(c * req.nTimepoints, (c + 1) * req.nTimepoints);
      const json = overview_cell(
        trace,
        req.fs,
        req.minSeparationSamples,
        req.isDff,
        req.baselineBins,
      ) as CellOverviewJson;
      cells.push(cellOverviewFromJson(json));
    }
    post({ type: 'overview-complete', jobId: req.jobId, cells });
  } catch (err) {
    post({ type: 'error', jobId: req.jobId, message: String(err) });
  }
}

onmessage = (e: MessageEvent<OverviewWorkerInbound>) => {
  try {
    if (e.data.type === 'overview-job') handleJob(e.data);
  } catch (err) {
    post({ type: 'error', jobId: e.data.jobId, message: String(err) });
  }
};

initWasm()
  .then(() => post({ type: 'ready' }))
  .catch((err) => {
    console.error('WASM initialization failed:', err);
    workerScope.postMessage({ type: 'init-error', message: String(err) });
  });
