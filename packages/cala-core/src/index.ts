export {
  AviReader,
  Extender,
  Fitter,
  MutationQueueHandle,
  Preprocessor,
  SnapshotHandle,
  init_panic_hook,
  initCalaCore,
  calaMemoryBytes,
  drainApplyEventsTyped,
} from './wasm-adapter.ts';

export type {
  WasmAppliedEvent,
  WasmComponentClass,
  WasmDeprecateReason,
  WasmDrainApplyEventsResult,
} from './wasm-adapter.ts';
