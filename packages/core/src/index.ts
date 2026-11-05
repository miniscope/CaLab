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
  DataSource,
} from './types.ts';
export { SAMPLING_RATE_PRESETS } from './types.ts';

// Solver types
export type { ConvMode, SolverParams, WarmStartStrategy } from './solver-types.ts';

// AR(2) coefficients
export { computeAR2 } from './ar2.ts';
export type { AR2Coefficients } from './ar2.ts';

// Parameter ranges
export { PARAM_RANGES, CONVERGENCE_RANGES } from './param-config.ts';

// Format utilities
export { formatDuration } from './format-utils.ts';

// Metrics
export type { SnrEvent, SnrReport } from './metrics/snr-events.ts';
export {
  OVERVIEW_PARAMS,
  HEIGHT_PROBS,
  FLAG_LABELS,
  FLAG_DESCRIPTIONS,
  FLAG_ORDER,
  MIN_CEILING_CELLS,
  medianOf,
  cellOverviewFromJson,
  buildDatasetOverview,
  isNearNoiseFloor,
  cellsWithFlag,
  flagCounts,
  sortCells,
  rowOfCell,
  processedCeiling,
  ceilingAt,
  fitCeilingC,
} from './metrics/dataset-overview.ts';
export type {
  CellOverview,
  CellOverviewJson,
  QualityFlag,
  BaselineMode,
  PopulationBaseline,
  DatasetOverview,
  CellSortKey,
  CeilingFit,
} from './metrics/dataset-overview.ts';
export { computeSparsityRatio, computeFitMetrics } from './metrics/solver-metrics.ts';
export type { FitMetricsResult } from './metrics/solver-metrics.ts';

// Spectrum
export { computePeriodogram } from './spectrum/fft.ts';
