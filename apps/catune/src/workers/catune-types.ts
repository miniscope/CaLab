// CaTune worker protocol and per-cell solver status. App-specific, so it lives
// here rather than in @calab/core (CaDecon's equivalent: cadecon-types.ts).

import type { SolverParams, WarmStartStrategy } from '@calab/core';

// --- Solver status types ---

/**
 * Per-cell solver status for multi-cell mode (used in multi-cell-store, CellCard, QualityBadge).
 * Tracks whether each cell's results are up to date:
 *   stale   -> parameters changed, results outdated / awaiting solver
 *   solving -> actively being solved
 *   fresh   -> results are current for the active parameters
 *   error   -> solver failed for this cell
 */
export type CellSolverStatus = 'stale' | 'solving' | 'fresh' | 'error';

// --- Pool worker message protocol ---

/** Messages sent TO a pool worker. */
export type PoolWorkerInbound =
  | {
      type: 'solve';
      jobId: number;
      trace: Float32Array;
      params: SolverParams;
      warmState: Uint8Array | null;
      warmStrategy: WarmStartStrategy;
      maxIterations?: number;
    }
  | { type: 'cancel' };

/** Messages sent FROM a pool worker. */
export type PoolWorkerOutbound =
  | { type: 'ready' }
  | {
      type: 'intermediate';
      jobId: number;
      solution: Float32Array;
      reconvolution: Float32Array;
      iteration: number;
    }
  | {
      type: 'complete';
      jobId: number;
      solution: Float32Array;
      reconvolution: Float32Array;
      state: Uint8Array;
      iterations: number;
      converged: boolean;
      filteredTrace?: Float32Array;
    }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number; message: string };
