// Solver input vocabulary shared by the WASM solver callers and
// @calab/compute's warm-start cache. App worker protocols live in the apps
// (apps/catune/src/workers/catune-types.ts, apps/cadecon/src/workers/cadecon-types.ts).

// --- Solver parameters ---

/** Convolution mode for forward/adjoint operations. */
export type ConvMode = 'fft' | 'banded';

/** Solver parameter configuration for calcium deconvolution. */
export interface SolverParams {
  tauRise: number; // seconds (e.g., 0.02)
  tauDecay: number; // seconds (e.g., 0.4)
  lambda: number; // sparsity penalty (e.g., 0.01)
  fs: number; // sampling rate in Hz (e.g., 30)
  filterEnabled: boolean; // bandpass filter derived from kernel
  convMode: ConvMode; // 'fft' or 'banded' (AR2 O(T))
}

/** Strategy for initializing the solver on a new solve request. */
export type WarmStartStrategy = 'warm' | 'warm-no-momentum' | 'cold';
