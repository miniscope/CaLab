export { createWorkerPool } from './worker-pool.ts';
export type { WorkerPool, BaseJob, MessageRouter } from './worker-pool.ts';
export { createCaTuneWorkerPool } from './catune-pool.ts';
export type { CaTunePoolJob } from './catune-pool.ts';
export { resolveWorkerCount, getWorkersOverride, getDefaultWorkerCount } from './worker-sizing.ts';
export {
  computePaddedWindow,
  computeSafeMargin,
  shouldWarmStart,
  WarmStartCache,
} from './warm-start-cache.ts';
export type { WarmStartEntry } from './warm-start-cache.ts';
export { computeKernel, computeKernelAnnotations } from './kernel-math.ts';
export { tauToShape, shapeToTau, computeFWHM, isValidShapePair } from './kernel-shape.ts';
export { downsampleMinMax } from './downsample.ts';
export { makeTimeAxis } from './time-axis.ts';
export { DEMO_PRESETS, DEFAULT_PRESET_ID, getPresetById, getPresetLabels } from './demo-presets.ts';
export type { DemoPreset } from './demo-presets.ts';
export { generateSyntheticTrace, generateSyntheticDataset } from './mock-traces.ts';
// Simulation types + presets (shared with Rust WASM simulation engine)
export type {
  SimulationConfig,
  SimulationResult,
  CellGroundTruth,
  KernelConfig as SimKernelConfig,
  NoiseConfig as SimNoiseConfig,
  MarkovConfig,
  PoissonConfig,
  SpikeModel,
  SinusoidalDrift,
  RandomWalkDrift,
  DriftModel,
  PhotobleachingConfig,
  SaturationConfig,
  CellVariationConfig,
} from './simulation-types.ts';
export type { SimulationPreset } from './simulation-presets.ts';
export {
  SIMULATION_PRESETS,
  DEFAULT_SIMULATION_PRESET_ID,
  getSimulationPresetById,
  getSimulationPresetLabels,
  simulationConfigToLegacyParams,
  PRESET_GCAMP6F,
  PRESET_GCAMP6S,
  PRESET_GCAMP6M,
  PRESET_JGCAMP8F,
  PRESET_OGB1,
  PRESET_CLEAN,
} from './simulation-presets.ts';
