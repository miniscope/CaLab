// CaTune's dataset overview store: the shared createOverviewStore() from
// @calab/ui/dataset, run on a dedicated short-lived overview pool, plus the
// per-cell SNR accessors the quality badge and "By SNR" selection read.
// Display and cell selection only: nothing in it feeds the solver.

import { createOverviewStore } from '@calab/ui/dataset';
import { createOverviewWorkerPool } from './overview-pool.ts';
import { importStore } from './data-store.ts';

export const { overview, overviewStatus, overviewProgress, overviewError, computeOverview } =
  createOverviewStore({ importStore, createPool: () => createOverviewWorkerPool() });

/** Measured SNR of every cell (indexed by cell id), or null before the overview is ready. */
export function snrByCell(): number[] | null {
  return overview()?.cells.map((c) => c.snr) ?? null;
}

export interface CellSnrInfo {
  snr: number;
  /** Mid-rank of the cell's SNR within the dataset, in [0, 1]. */
  rank: number;
  silent: boolean;
  nCells: number;
}

/** SNR, dataset-relative rank and silent flag of one cell; undefined until the overview is ready. */
export function cellSnrInfo(cellIndex: number): CellSnrInfo | undefined {
  const ov = overview();
  const cell = ov?.cells[cellIndex];
  if (!ov || !cell) return undefined;
  return { snr: cell.snr, rank: ov.snrRank[cellIndex], silent: cell.isSilent, nCells: ov.nCells };
}
