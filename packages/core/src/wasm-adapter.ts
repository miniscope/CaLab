/**
 * Single import point for the WASM solver module.
 *
 * Rule: No other file should import from 'crates/solver/pkg/' directly.
 * This adapter provides lazy, idempotent initialization and re-exports the
 * Solver class so consumers never deal with raw WASM init.
 */

import init, {
  Solver,
  indeca_solve_trace,
  indeca_estimate_kernel,
  indeca_fit_biexponential,
  indeca_compute_upsample_factor,
  seed_trace,
  simulate_traces,
  get_simulation_presets,
} from '../../../crates/solver/pkg/calab_solver';
export {
  Solver,
  indeca_solve_trace,
  indeca_estimate_kernel,
  indeca_fit_biexponential,
  indeca_compute_upsample_factor,
  seed_trace,
  simulate_traces,
  get_simulation_presets,
};

let wasmReady: Promise<void> | null = null;

/**
 * Initialize the WASM module. Lazy and idempotent — safe to call from
 * multiple sites; only the first call triggers actual initialization.
 */
export function initWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = init()
      .then(() => {})
      .catch((err) => {
        // Clear the cached promise so a later call can retry instead of
        // being permanently stuck on a rejected init.
        wasmReady = null;
        throw err;
      });
  }
  return wasmReady;
}
