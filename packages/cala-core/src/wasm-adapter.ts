/**
 * Single import point for the cala-core WASM module.
 *
 * Rule: no other file should import from `crates/cala-core/pkg/` directly.
 * This adapter provides lazy, idempotent initialization and re-exports
 * the binding types so consumers never deal with raw WASM init. Mirrors
 * `@calab/core`'s `wasm-adapter.ts` for the solver — keeping the two
 * adapters structurally identical makes it obvious where each type
 * comes from (solver vs cala-core) and avoids cross-contamination of
 * init promises.
 */

import init, {
  AviReader,
  Fitter,
  MutationQueueHandle,
  Preprocessor,
  SnapshotHandle,
  init_panic_hook,
} from '../../../crates/cala-core/pkg/calab_cala_core';

export { AviReader, Fitter, MutationQueueHandle, Preprocessor, SnapshotHandle, init_panic_hook };

let calaReady: Promise<void> | null = null;

/**
 * Initialize the cala-core WASM module. Lazy and idempotent — safe to
 * call from multiple sites (worker boot paths, tests). Only the first
 * call triggers actual initialization. The installed panic hook
 * surfaces Rust panics as console errors instead of opaque WASM traps.
 */
export function initCalaCore(): Promise<void> {
  if (!calaReady) {
    calaReady = init().then(() => {
      init_panic_hook();
    });
  }
  return calaReady;
}
