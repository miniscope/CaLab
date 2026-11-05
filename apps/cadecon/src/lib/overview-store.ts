// CaDecon's dataset overview store: the shared createOverviewStore() from
// @calab/ui/dataset, run on the CaDecon worker pool once the import is
// confirmed. Display only: nothing here feeds the solver (results live in
// iteration-store.ts).

import { createRoot, createEffect, on } from 'solid-js';
import { createOverviewStore } from '@calab/ui/dataset';
import { createCaDeconWorkerPool } from './cadecon-pool.ts';
import {
  importStore,
  parsedData,
  effectiveShape,
  swapped,
  samplingRate,
  importStep,
} from './data-store.ts';

const store = createOverviewStore({
  importStore,
  createPool() {
    const pool = createCaDeconWorkerPool();
    return {
      size: pool.size,
      dispatch: (job) => pool.dispatch({ ...job, kind: 'overview' }),
      dispose: () => pool.dispose(),
    };
  },
  logLabel: 'CaDecon',
});

export const { overview, overviewStatus, overviewProgress, overviewError, computeOverview } = store;

/** Recompute whenever the dataset (or its orientation / rate) changes. Call once at app start. */
export function setupOverviewEffects(): void {
  createRoot(() => {
    createEffect(
      on([importStep, parsedData, effectiveShape, swapped, samplingRate], () => {
        // Only once the import is confirmed: earlier steps still change shape/rate.
        if (importStep() === 'ready') void computeOverview();
        else store.resetOverview();
      }),
    );
  });
}
