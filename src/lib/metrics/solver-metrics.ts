/**
 * Solver output quality metrics.
 * Measures how well the deconvolution solution fits the data.
 */

/**
 * Compute the sparsity ratio of the deconvolved trace.
 * Fraction of values that are effectively zero (below threshold).
 */
export function computeSparsityRatio(
  deconvolved: Float64Array,
  threshold: number = 1e-6,
): number {
  if (deconvolved.length === 0) return 0;
  let zeroCount = 0;
  for (let i = 0; i < deconvolved.length; i++) {
    if (Math.abs(deconvolved[i]) < threshold) zeroCount++;
  }
  return zeroCount / deconvolved.length;
}

/**
 * Compute the RMS of the residual (raw - reconvolution).
 * Lower = better fit.
 */
export function computeResidualRMS(
  raw: Float64Array,
  reconvolution: Float64Array,
): number {
  if (raw.length === 0 || raw.length !== reconvolution.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < raw.length; i++) {
    const d = raw[i] - reconvolution[i];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / raw.length);
}

/**
 * Compute R-squared (coefficient of determination).
 * 1.0 = perfect fit, 0 = no better than mean, negative = worse than mean.
 */
export function computeRSquared(
  raw: Float64Array,
  reconvolution: Float64Array,
): number {
  if (raw.length === 0 || raw.length !== reconvolution.length) return 0;

  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i];
  const mean = sum / raw.length;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < raw.length; i++) {
    const d = raw[i] - mean;
    ssTot += d * d;
    const r = raw[i] - reconvolution[i];
    ssRes += r * r;
  }

  if (ssTot === 0) return 1;
  return 1 - ssRes / ssTot;
}
