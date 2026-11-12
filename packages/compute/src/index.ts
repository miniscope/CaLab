export { createWorkerPool } from './worker-pool.ts';
export type { WorkerPool, BaseJob, MessageRouter, WorkerPoolOptions } from './worker-pool.ts';
export { resolveWorkerCount, getWorkersOverride, getDefaultWorkerCount } from './worker-sizing.ts';
export { computePaddedWindow, computeSafeMargin, WarmStartCache } from './warm-start-cache.ts';
export {
  computeKernel,
  computeKernelAnnotations,
  kernelShapeRmse,
  KERNEL_DURATION_MULTIPLE,
} from './kernel-math.ts';
export { tauToShape, shapeToTau } from './kernel-shape.ts';
export { downsampleMinMax } from './downsample.ts';
export { computeBandLayout, scaleToBand, residualBandSeries } from './residual.ts';
export { computeDisplayOffset } from './display-offset.ts';
export type { BandLayout, BandSpacing } from './residual.ts';
export { makeTimeAxis } from './time-axis.ts';
export { generateSyntheticTrace } from './mock-traces.ts';
// Simulation types consumed by apps' data-store. Internal shape
// sub-types (MarkovConfig, SpikeModel, etc.) stay unexported — they're
// reachable through SimulationConfig for type inference without leaking
// into the public API.
export type { SimulationConfig, SimulationResult } from './simulation-types.ts';
export type { SimulationPreset } from './simulation-presets.ts';
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
// Solver backends: tile work queue, consumers, and the dev backend switch.
export type {
  SolveTile,
  TileWarmStart,
  TileCellUpdate,
  TileCellResult,
  TileCallbacks,
  TileConsumer,
  ConsumerContext,
  TileAssignPolicy,
  BackendCalibration,
} from './solve-tiles.ts';
export { createTileScheduler } from './tile-scheduler.ts';
export type { TileScheduler, TileSchedulerOptions } from './tile-scheduler.ts';
export { createWasmPoolConsumer } from './wasm-pool-consumer.ts';
export type { WasmPoolConsumerOptions, CellJobCallbacks } from './wasm-pool-consumer.ts';
export {
  createGpuBatchConsumer,
  DEFAULT_GPU_MEMORY_BUDGET,
  GPU_STARTUP_TIMEOUT_MS,
} from './gpu-batch-consumer.ts';
export { GpuOutOfMemoryError, GpuDeviceLostError } from './gpu-errors.ts';
export type {
  BatchSolutions,
  BatchWarmStart,
  BatchStatus,
  BatchStepResult,
  DisplayReconvolution,
  GpuBatchConsumer,
  GpuBatchConsumerOptions,
  GpuBatchStats,
  BatchFistaEngine,
  BatchFistaParams,
} from './gpu-batch-consumer.ts';
export { encodeSolverState, decodeSolverState } from './solver-state-codec.ts';
export type { DecodedSolverState } from './solver-state-codec.ts';
export {
  getRequestedBackend,
  getRequestedGpuGate,
  webGpuUnavailableReason,
} from './backend-selection.ts';
export type { RequestedBackend, GpuGateMode } from './backend-selection.ts';
export {
  createCalibrationStore,
  softwareAdapterReason,
  gpuParticipationVerdict,
} from './calibration.ts';
export type { CalibrationStore, AdapterLike } from './calibration.ts';
export { StreamHistory } from './stream-history.ts';
export type {
  SeriesKind,
  RangeRule,
  SeriesSpec,
  StreamHistoryOptions,
  BinView,
  BinValue,
  RangeExpansion,
  DisplayRange,
  LevelInfo,
  HistoryExport,
} from './stream-history.ts';
