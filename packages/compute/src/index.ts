export { createWorkerPool } from './worker-pool.ts';
export type { WorkerPool, BaseJob, MessageRouter } from './worker-pool.ts';
export { createCaTuneWorkerPool } from './catune-pool.ts';
export type { CaTunePoolJob } from './catune-pool.ts';
export { resolveWorkerCount, getWorkersOverride, getDefaultWorkerCount } from './worker-sizing.ts';
export { computePaddedWindow, computeSafeMargin, WarmStartCache } from './warm-start-cache.ts';
export { computeKernel, computeKernelAnnotations } from './kernel-math.ts';
export { tauToShape, shapeToTau, isValidShapePair } from './kernel-shape.ts';
export { downsampleMinMax } from './downsample.ts';
export { makeTimeAxis } from './time-axis.ts';
export { generateSyntheticTrace } from './mock-traces.ts';
// Simulation types consumed by apps' data-store. Internal shape
// sub-types (MarkovConfig, SpikeModel, etc.) stay unexported — they're
// reachable through SimulationConfig for type inference without leaking
// into the public API.
export type { SimulationConfig, SimulationResult } from './simulation-types.ts';
export type { SimulationPreset } from './simulation-presets.ts';
export { getSimulationPresetLabels } from './simulation-presets.ts';
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
