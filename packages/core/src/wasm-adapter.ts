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
  solver_version,
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
  // Solver version (crates/solver Cargo.toml `version`); requires initWasm().
  // An app that adds it to its bridge results as `solver_version` gets it
  // checked against `calab._solver.protocol_version()` by the Python bridge.
  solver_version,
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

/**
 * Initialize WASM (if needed) and return the solver version, or `undefined`
 * if the module fails to load. Apps add the result to their bridge payloads
 * as the optional `solver_version` field, which the Python bridge compares
 * against `calab._solver.protocol_version()`. A missing value skips that half
 * of the handshake rather than failing the export.
 */
export async function getSolverVersion(): Promise<string | undefined> {
  try {
    await initWasm();
    return solver_version();
  } catch (err) {
    console.warn('Could not read solver_version from WASM:', err);
    return undefined;
  }
}
