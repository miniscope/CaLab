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
export { generateSyntheticTrace } from './mock-traces.ts';
// Simulation types
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
} from './simulation-types.ts';
export type { SimulationPreset } from './simulation-presets.ts';
export {
  SIMULATION_PRESETS,
  DEFAULT_SIMULATION_PRESET_ID,
  getSimulationPresetById,
  getSimulationPresetLabels,
} from './simulation-presets.ts';
// Qualitative presets (per-step level selections for UI)
export type { QualitativeSimConfig, IndicatorId } from './simulation-quality-presets.ts';
export {
  buildSimulationConfig,
  DEFAULT_QUALITATIVE_CONFIG,
  INDICATOR_OPTIONS,
  SPIKE_ACTIVITY_LEVELS,
  NOISE_LEVELS,
  DRIFT_LEVELS,
  PHOTOBLEACHING_LEVELS,
  SATURATION_LEVELS,
  AMPLITUDE_VARIATION_LEVELS,
  KERNEL_VARIATION_LEVELS,
} from './simulation-quality-presets.ts';
