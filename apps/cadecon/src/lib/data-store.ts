// CaDecon's import store: the shared createImportStore() from @calab/io,
// instantiated once and re-exported member by member so app code keeps
// importing plain signals (`import { parsedData } from '../lib/data-store.ts'`).
// Shared import components take `importStore` itself as a prop.

import { createImportStore } from '@calab/io';
import { initWasm, simulate_traces } from '@calab/core/wasm';
import type { SimulationResult } from '@calab/compute';

export const importStore = createImportStore({
  appName: 'CaDecon',
  simulate: async (config) => {
    await initWasm();
    return simulate_traces(config) as SimulationResult;
  },
});

export const {
  // Getters (signals)
  rawFile,
  parsedData,
  swapped,
  samplingRate,
  // Setters
  setParsedData,
  setDimensionsConfirmed,
  setSwapped,
  setSamplingRate,
  // Derived
  effectiveShape,
  nonFiniteCounts,
  numCells,
  numTimepoints,
  durationSeconds,
  importStep,
  isDemo,
  // Actions
  resetImport,
  loadDemoData,
  loadFromBridge,
  // Bridge
  bridgeUrl,
  bridgeExportDone,
  setBridgeExportDone,
  bridgeExportError,
  setBridgeExportError,
  // Data source tracking
  dataSource,
  // Ground truth & advanced features
  demoIndicator,
  groundTruthVisible,
  groundTruthLocked,
  groundTruthTauRise,
  groundTruthTauDecay,
  getGroundTruthForCell,
} = importStore;
