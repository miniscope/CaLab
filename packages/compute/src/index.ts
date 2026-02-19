export { createWorkerPool } from './worker-pool.ts';
export type { PoolJob, WorkerPool } from './worker-pool.ts';
export {
  computePaddedWindow,
  computeSafeMargin,
  shouldWarmStart,
  WarmStartCache,
} from './warm-start-cache.ts';
export type { WarmStartEntry } from './warm-start-cache.ts';
export { computeKernel, computeKernelAnnotations } from './kernel-math.ts';
export { downsampleMinMax } from './downsample.ts';
export { makeTimeAxis } from './time-axis.ts';
export { DEMO_PRESETS, DEFAULT_PRESET_ID, getPresetById, getPresetLabels } from './demo-presets.ts';
export type { MarkovParams, NoiseParams, SimulationParams, DemoPreset } from './demo-presets.ts';
export { generateSyntheticTrace, generateSyntheticDataset } from './mock-traces.ts';
