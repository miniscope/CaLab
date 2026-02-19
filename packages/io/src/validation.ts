// Data validation for calcium imaging trace data
// Single-pass validation: detects NaN, Inf, suspicious shapes, and computes stats

import type { ValidationResult, ValidationWarning, ValidationError, DataStats } from '@calab/core';

/**
 * Create empty/default stats for early-return error cases.
 */
function emptyStats(totalElements: number): DataStats {
  return {
    min: Infinity,
    max: -Infinity,
    mean: NaN,
    nanCount: 0,
    infCount: 0,
    negativeCount: 0,
    totalElements,
  };
}

/**
 * Validate trace data for common issues before processing.
 *
 * Performs all checks in a single pass over the data array for efficiency.
 * Returns a ValidationResult with errors (blocking) and warnings (informational).
 *
 * @param data - The typed array of trace data
 * @param shape - The shape of the array (expected to be [cells, timepoints])
 * @returns ValidationResult with isValid flag, warnings, errors, and computed stats
 */
export function validateTraceData(
  data: Float64Array | Float32Array,
  shape: number[],
): ValidationResult {
  const warnings: ValidationWarning[] = [];
  const errors: ValidationError[] = [];

  // Error: must be 2D
  if (shape.length !== 2) {
    errors.push({
      type: 'not_2d',
      message: `Expected a 2D array (cells x timepoints), got ${shape.length}D array with shape [${shape.join(', ')}]`,
    });
    return { isValid: false, warnings, errors, stats: emptyStats(data.length) };
  }

  // Error: empty
  if (data.length === 0) {
    errors.push({
      type: 'empty_array',
      message: 'Array is empty (0 elements)',
    });
    return { isValid: false, warnings, errors, stats: emptyStats(0) };
  }

  // Single-pass stats computation
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let nanCount = 0;
  let infCount = 0;
  let negCount = 0;

  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isNaN(v)) {
      nanCount++;
      continue;
    }
    if (!Number.isFinite(v)) {
      infCount++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    if (v < 0) negCount++;
    sum += v;
  }

  const validCount = data.length - nanCount - infCount;
  const mean = validCount > 0 ? sum / validCount : NaN;

  const stats: DataStats = {
    min,
    max,
    mean,
    nanCount,
    infCount,
    negativeCount: negCount,
    totalElements: data.length,
  };

  // Error: all NaN
  if (nanCount === data.length) {
    errors.push({
      type: 'all_nan',
      message: 'All values are NaN',
    });
    return { isValid: false, warnings, errors, stats };
  }

  // Warning: NaN values present
  if (nanCount > 0) {
    const pct = ((nanCount / data.length) * 100).toFixed(1);
    warnings.push({
      type: 'nan_values',
      message: `${nanCount} NaN values detected (${pct}%)`,
      details:
        'NaN values may indicate preprocessing errors. CaTune will skip NaN values during deconvolution.',
      count: nanCount,
    });
  }

  // Warning: Inf values present
  if (infCount > 0) {
    warnings.push({
      type: 'inf_values',
      message: `${infCount} Inf values detected`,
      details:
        'Infinite values indicate preprocessing errors and must be fixed before deconvolution.',
      count: infCount,
    });
  }

  // Warning: suspicious shape (rows > cols -- may be transposed)
  const [rows, cols] = shape;
  if (rows > cols) {
    warnings.push({
      type: 'suspicious_shape',
      message: `Array has more rows (${rows}) than columns (${cols})`,
      details:
        'Typical calcium traces have cells as rows and timepoints as columns. ' +
        'If your recording has more cells than timepoints, this is correct. ' +
        'Otherwise, use the swap button.',
    });
  }

  return {
    isValid: errors.length === 0,
    warnings,
    errors,
    stats,
  };
}
