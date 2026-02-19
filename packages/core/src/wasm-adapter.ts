/**
 * Single import point for the WASM solver module.
 *
 * Rule: No other file should import from 'wasm/catune-solver/pkg/' directly.
 * This adapter provides lazy, idempotent initialization and re-exports the
 * Solver class so consumers never deal with raw WASM init.
 */

import init, { Solver } from '../../../wasm/catune-solver/pkg/catune_solver';
export { Solver };
export type { InitInput, InitOutput } from '../../../wasm/catune-solver/pkg/catune_solver';

let wasmReady: Promise<void> | null = null;

/**
 * Initialize the WASM module. Lazy and idempotent — safe to call from
 * multiple sites; only the first call triggers actual initialization.
 */
export function initWasm(): Promise<void> {
  if (!wasmReady) wasmReady = init().then(() => {});
  return wasmReady;
}
