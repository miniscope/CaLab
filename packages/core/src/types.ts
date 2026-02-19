// --- Typed Array Union ---

export type NumericTypedArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Int8Array
  | Uint32Array
  | Uint16Array
  | Uint8Array;

// --- NPY/NPZ Parser Results ---

export interface NpyResult {
  data: NumericTypedArray;
  shape: number[];
  dtype: string;
  fortranOrder: boolean;
}

export interface NpzResult {
  arrays: Record<string, NpyResult>;
  arrayNames: string[];
}

// --- Data Validation ---

export interface ValidationWarning {
  type:
    | 'nan_values'
    | 'inf_values'
    | 'negative_values'
    | 'extreme_values'
    | 'constant_traces'
    | 'suspicious_shape';
  message: string;
  details: string;
  count?: number;
}

export interface ValidationError {
  type: 'all_nan' | 'wrong_dtype' | 'empty_array' | 'not_2d';
  message: string;
}

export interface DataStats {
  min: number;
  max: number;
  mean: number;
  nanCount: number;
  infCount: number;
  negativeCount: number;
  totalElements: number;
}

export interface ValidationResult {
  isValid: boolean;
  warnings: ValidationWarning[];
  errors: ValidationError[];
  stats: DataStats;
}

// --- Import Pipeline ---

export type ImportStep = 'drop' | 'confirm-dims' | 'sampling-rate' | 'validation' | 'ready';

// --- Sampling Rate Presets ---

export const SAMPLING_RATE_PRESETS = [
  { label: '30 Hz (miniscope)', value: 30 },
  { label: '30 Hz (2-photon)', value: 30 },
  { label: '15 Hz (slow 2-photon)', value: 15 },
  { label: '10 Hz (widefield)', value: 10 },
  { label: '60 Hz (fast miniscope)', value: 60 },
] as const;
