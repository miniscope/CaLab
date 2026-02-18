/**
 * Signal-to-noise ratio computation for calcium traces.
 * Uses peak-based SNR: ratio of signal range to baseline noise (RMS of residual).
 *
 * SNR is cached per trace identity since raw traces are immutable after load.
 */

// Cache keyed by Float64Array identity (reference equality).
// Raw traces never change after load, so this is safe and avoids
// the O(n log n) sort on every render cycle.
const snrCache = new WeakMap<Float64Array, number>();

/**
 * Compute peak SNR for a calcium trace.
 * SNR = (max - baseline_mean) / baseline_std
 *
 * Baseline is estimated from the lower 25th percentile of the trace.
 * This is appropriate for calcium traces where most of the trace
 * is at baseline with occasional transient peaks.
 *
 * Results are cached per trace reference since raw traces are immutable.
 *
 * @returns SNR value (higher = better signal quality)
 */
export function computePeakSNR(trace: Float64Array): number {
  if (trace.length < 10) return 0;

  const cached = snrCache.get(trace);
  if (cached !== undefined) return cached;

  // Sort a copy to find percentiles
  const sorted = Float64Array.from(trace).sort();
  const n = sorted.length;

  // Baseline: lower 25th percentile
  const q25Idx = Math.floor(n * 0.25);
  let baselineSum = 0;
  let baselineSumSq = 0;
  for (let i = 0; i < q25Idx; i++) {
    baselineSum += sorted[i];
    baselineSumSq += sorted[i] * sorted[i];
  }
  const baselineMean = baselineSum / q25Idx;
  const baselineVar = baselineSumSq / q25Idx - baselineMean * baselineMean;
  const baselineStd = Math.sqrt(Math.max(0, baselineVar));

  if (baselineStd === 0) {
    snrCache.set(trace, Infinity);
    return Infinity;
  }

  // Peak: 95th percentile to be robust against outliers
  const q95Idx = Math.floor(n * 0.95);
  const peak = sorted[q95Idx];

  const snr = (peak - baselineMean) / baselineStd;
  snrCache.set(trace, snr);
  return snr;
}

/** Quality tier based on peak SNR */
export type QualityTier = 'good' | 'fair' | 'poor';

export function snrToQuality(snr: number): QualityTier {
  if (snr >= 5) return 'good';
  if (snr >= 2) return 'fair';
  return 'poor';
}
