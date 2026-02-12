/**
 * Signal-to-noise ratio computation for calcium traces.
 * Uses peak-based SNR: ratio of signal range to baseline noise (RMS of residual).
 */

/**
 * Compute peak SNR for a calcium trace.
 * SNR = (max - baseline_mean) / baseline_std
 *
 * Baseline is estimated from the lower 25th percentile of the trace.
 * This is appropriate for calcium traces where most of the trace
 * is at baseline with occasional transient peaks.
 *
 * @returns SNR value (higher = better signal quality)
 */
export function computePeakSNR(trace: Float64Array): number {
  if (trace.length < 10) return 0;

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

  if (baselineStd === 0) return Infinity;

  // Peak: 95th percentile to be robust against outliers
  const q95Idx = Math.floor(n * 0.95);
  const peak = sorted[q95Idx];

  return (peak - baselineMean) / baselineStd;
}

/**
 * Compute RMS SNR (signal power / noise power).
 * Uses residual trace if available, otherwise estimates noise
 * from high-frequency component (diff filter).
 *
 * @param raw - Raw fluorescence trace
 * @param residual - Optional residual trace (raw - fit)
 * @returns SNR in dB-like scale (10 * log10(signal_var / noise_var))
 */
export function computeRmsSNR(raw: Float64Array, residual?: Float64Array): number {
  if (raw.length < 10) return 0;

  // Signal variance
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < raw.length; i++) {
    sum += raw[i];
    sumSq += raw[i] * raw[i];
  }
  const signalMean = sum / raw.length;
  const signalVar = sumSq / raw.length - signalMean * signalMean;

  // Noise variance
  let noiseVar: number;
  if (residual && residual.length === raw.length) {
    let nSum = 0;
    let nSumSq = 0;
    for (let i = 0; i < residual.length; i++) {
      nSum += residual[i];
      nSumSq += residual[i] * residual[i];
    }
    const nMean = nSum / residual.length;
    noiseVar = nSumSq / residual.length - nMean * nMean;
  } else {
    // Estimate noise from first-order differences
    let diffSumSq = 0;
    for (let i = 1; i < raw.length; i++) {
      const d = raw[i] - raw[i - 1];
      diffSumSq += d * d;
    }
    noiseVar = diffSumSq / (2 * (raw.length - 1));
  }

  if (noiseVar === 0) return Infinity;
  return 10 * Math.log10(signalVar / noiseVar);
}

/** Quality tier based on peak SNR */
export type QualityTier = 'good' | 'fair' | 'poor';

export function snrToQuality(snr: number): QualityTier {
  if (snr >= 5) return 'good';
  if (snr >= 2) return 'fair';
  return 'poor';
}
