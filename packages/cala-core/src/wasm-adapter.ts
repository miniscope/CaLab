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
  Extender,
  Fitter,
  MutationQueueHandle,
  Preprocessor,
  SnapshotHandle,
  init_panic_hook,
} from '../../../crates/cala-core/pkg/calab_cala_core';

export {
  AviReader,
  Extender,
  Fitter,
  MutationQueueHandle,
  Preprocessor,
  SnapshotHandle,
  init_panic_hook,
};

let calaReady: Promise<void> | null = null;
let calaMemory: WebAssembly.Memory | null = null;

/**
 * Initialize the cala-core WASM module. Lazy and idempotent — safe to
 * call from multiple sites (worker boot paths, tests). Only the first
 * call triggers actual initialization. The installed panic hook
 * surfaces Rust panics as console errors instead of opaque WASM traps.
 */
export function initCalaCore(): Promise<void> {
  if (!calaReady) {
    calaReady = init().then((mod: { memory: WebAssembly.Memory }) => {
      calaMemory = mod.memory;
      init_panic_hook();
    });
  }
  return calaReady;
}

/**
 * Current byte size of cala-core's WASM linear memory, or `null` if
 * the module has not been initialized yet. Used by the fit worker to
 * report `memoryBytes` as a vitals metric (design §12).
 */
export function calaMemoryBytes(): number | null {
  return calaMemory ? calaMemory.buffer.byteLength : null;
}

// ── Phase 7: drainApplyEvents wire shape ──────────────────────────────
//
// Mirrors the Rust `AppliedEvent` tagged union (see
// `crates/cala-core/src/fitting/pipeline.rs`). We duplicate the shape
// here rather than generating it from the `.d.ts` (wasm-bindgen emits
// `any` for `serde_wasm_bindgen` returns) so TS callers get full
// autocomplete + exhaustiveness checking on `kind`.
export type WasmComponentClass = 'cell' | 'slowBaseline' | 'neuropil';

export type WasmDeprecateReason =
  | 'footprintCollapsed'
  | 'traceInactive'
  | 'mergedInto'
  | 'invalidApply';

export type WasmAppliedEvent =
  | {
      kind: 'birth';
      id: number;
      class: WasmComponentClass;
      support: number[];
      values: number[];
      patch: [number, number];
    }
  | {
      kind: 'merge';
      ids: [number, number];
      into: number;
      class: WasmComponentClass;
      support: number[];
      values: number[];
    }
  | {
      kind: 'deprecate';
      id: number;
      reason: WasmDeprecateReason;
    };

export interface WasmDrainApplyEventsResult {
  /** `[applied, stale, invalid]` — matches `drainApply`'s return. */
  report: [number, number, number];
  events: WasmAppliedEvent[];
}

/**
 * Typed wrapper around `Fitter.drainApplyEvents`. Centralizing the
 * cast keeps callers from repeating `as WasmDrainApplyEventsResult`
 * and documents the shape the Rust binding promises.
 */
export function drainApplyEventsTyped(
  fitter: Fitter,
  queue: MutationQueueHandle,
): WasmDrainApplyEventsResult {
  return fitter.drainApplyEvents(queue) as WasmDrainApplyEventsResult;
}
