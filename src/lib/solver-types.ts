// --- Solver status types ---

/**
 * Single-cell solver state machine (used in viz-store).
 * Tracks the lifecycle of one solve operation:
 *   idle      -> waiting for input / no solve in progress
 *   solving   -> FISTA iteration active
 *   converged -> solver finished successfully
 *   error     -> solver encountered an error
 */
export type SolverStatus = 'idle' | 'solving' | 'converged' | 'error';

/**
 * Per-cell solver status for multi-cell mode (used in multi-cell-store, CellCard, QualityBadge).
 * Tracks whether each cell's results are up to date:
 *   stale   -> parameters changed, results outdated / awaiting solver
 *   solving -> actively being solved
 *   fresh   -> results are current for the active parameters
 *   error   -> solver failed for this cell
 */
export type CellSolverStatus = 'stale' | 'solving' | 'fresh' | 'error';

// --- Solver parameters ---

/** Solver parameter configuration for calcium deconvolution. */
export interface SolverParams {
  tauRise: number;   // seconds (e.g., 0.02)
  tauDecay: number;  // seconds (e.g., 0.4)
  lambda: number;    // sparsity penalty (e.g., 0.01)
  fs: number;        // sampling rate in Hz (e.g., 30)
  filterEnabled: boolean;  // bandpass filter derived from kernel
}

/** Intermediate result emitted during solver iteration for live visualization. */
export interface IntermediateResult {
  solution: Float32Array;
  reconvolution: Float32Array;
  iteration: number;
}

/** Final result returned after solver convergence or termination. */
export interface SolveResult {
  solution: Float32Array;
  reconvolution: Float32Array;
  state: Uint8Array;          // serialized warm-start state
  iterations: number;
  converged: boolean;
}

/** Strategy for initializing the solver on a new solve request. */
export type WarmStartStrategy = 'warm' | 'warm-no-momentum' | 'cold';

/** Full solve request message sent to the worker. */
export interface SolveRequest {
  trace: Float32Array;
  params: SolverParams;
  warmStartState: Uint8Array | null;
  warmStartStrategy: WarmStartStrategy;
  jobId: number;
}

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
