// Barrel file — public API for the chart module.
// Import from 'lib/chart' rather than reaching into internals.

export { DEMO_PRESETS, DEFAULT_PRESET_ID, getPresetById, getPresetLabels } from './demo-presets.ts';
export type { MarkovParams, NoiseParams, SimulationParams, DemoPreset } from './demo-presets.ts';
export { downsampleMinMax } from './downsample.ts';
export { kernelAnnotationsPlugin } from './kernel-annotations-plugin.ts';
export type { KernelAnnotations } from './kernel-annotations-plugin.ts';
export { computeKernel, computeKernelAnnotations } from './kernel-math.ts';
export { generateSyntheticTrace, generateSyntheticDataset } from './mock-traces.ts';
export {
  withOpacity,
  createRawSeries,
  createFilteredSeries,
  createFitSeries,
  createDeconvolvedSeries,
  createResidualSeries,
  createGroundTruthSpikesSeries,
  createGroundTruthCalciumSeries,
  createGroundTruthKernelSeries,
  createPinnedOverlaySeries,
} from './series-config.ts';
export { getThemeColors } from './theme-colors.ts';
export { makeTimeAxis } from './time-axis.ts';
export { wheelZoomPlugin } from './wheel-zoom-plugin.ts';
