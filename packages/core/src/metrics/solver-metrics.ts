/**
 * Solver output quality metrics.
 * Measures how well the deconvolution solution fits the data.
 */

/**
 * Compute the sparsity ratio of the deconvolved trace.
 * Fraction of values that are effectively zero (below threshold).
 */
export function computeSparsityRatio(
  deconvolved: Float64Array | Float32Array,
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
 * Compute the RMS of the residual (reference - reconvolution).
 * Lower = better fit. `reference` must be the trace the fit was made to (the
 * solver's working trace over the same window), not the raw trace.
 *
 * Returns NaN for a length mismatch (never a number that looks like a result);
 * 0 for empty input. Use `computeFitMetrics` to learn why a value is missing.
 */
export function computeResidualRMS(
  raw: ArrayLike<number>,
  reconvolution: ArrayLike<number>,
): number {
  if (raw.length === 0) return 0;
  if (raw.length !== reconvolution.length) return NaN;
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
 * NaN for a length mismatch, 0 for empty input (see `computeResidualRMS`).
 */
export function computeRSquared(raw: ArrayLike<number>, reconvolution: ArrayLike<number>): number {
  if (raw.length === 0) return 0;
  if (raw.length !== reconvolution.length) return NaN;

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

export type FitMetricsResult =
  | { ok: true; residualRms: number; rSquared: number }
  | {
      ok: false;
      reason: 'no-reference' | 'length-mismatch';
      referenceLength: number;
      fitLength: number;
    };

/**
 * Fit quality of a reconvolution against the trace it was fitted to.
 *
 * Compare like with like: the solver fits its working trace (baseline-subtracted,
 * optionally bandpass-filtered) over a window, so the reference must be that
 * working trace over the same window, not the full raw trace. A missing
 * reference or a length mismatch is reported explicitly instead of as a 0.
 */
export function computeFitMetrics(
  reference: ArrayLike<number> | null | undefined,
  reconvolution: ArrayLike<number>,
): FitMetricsResult {
  if (!reference || reference.length === 0) {
    return {
      ok: false,
      reason: 'no-reference',
      referenceLength: 0,
      fitLength: reconvolution.length,
    };
  }
  if (reference.length !== reconvolution.length) {
    return {
      ok: false,
      reason: 'length-mismatch',
      referenceLength: reference.length,
      fitLength: reconvolution.length,
    };
  }
  return {
    ok: true,
    residualRms: computeResidualRMS(reference, reconvolution),
    rSquared: computeRSquared(reference, reconvolution),
  };
}
