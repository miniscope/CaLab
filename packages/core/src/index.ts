export {
  initWasm,
  Solver,
  indeca_solve_trace,
  indeca_estimate_kernel,
  indeca_fit_biexponential,
  indeca_compute_upsample_factor,
} from './wasm-adapter.ts';
export { CaTuneExportSchema } from './schemas/export-schema.ts';
export type { CaTuneExportData } from './schemas/export-schema.ts';

// Shared types
export type {
  NumericTypedArray,
  NpyResult,
  NpzResult,
  ValidationWarning,
  ValidationError,
  DataStats,
  ValidationResult,
  ImportStep,
} from './types.ts';
export { SAMPLING_RATE_PRESETS } from './types.ts';

// Solver types
export type {
  ConvMode,
  CellSolverStatus,
  SolverParams,
  WarmStartStrategy,
  PoolWorkerInbound,
  PoolWorkerOutbound,
} from './solver-types.ts';

// AR(2) coefficients
export { computeAR2 } from './ar2.ts';
export type { AR2Coefficients } from './ar2.ts';

// Parameter ranges
export { PARAM_RANGES } from './param-config.ts';

// Format utilities
export { formatDuration } from './format-utils.ts';

// Metrics
export { computePeakSNR, snrToQuality } from './metrics/snr.ts';
export type { QualityTier } from './metrics/snr.ts';
export {
  computeSparsityRatio,
  computeResidualRMS,
  computeRSquared,
} from './metrics/solver-metrics.ts';

// Spectrum
export { computePeriodogram } from './spectrum/fft.ts';
