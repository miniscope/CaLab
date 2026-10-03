// The app's import store (file drop, .npz/.mat array selection, dimensions,
// sampling rate, validation), shared with CaTune and CaDecon via @calab/io.
// The @calab/ui/import components take it as a prop.

import { createImportStore } from '@calab/io';
import type { SimulationResult } from '@calab/compute';

export const importStore = createImportStore({
  appName: '__APP_DISPLAY_NAME__',
  // Demo data comes from the Rust simulator. It is imported on first use, so
  // the WASM module loads only when someone asks for demo data. On the main
  // thread it needs no `{ wasm: true }` in vite.config.ts.
  simulate: async (config) => {
    const { initWasm, simulate_traces } = await import('@calab/core/wasm');
    await initWasm();
    return simulate_traces(config) as SimulationResult;
  },
});
