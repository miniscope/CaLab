// Shared time axis generation for trace panels.

/**
 * Build a time axis array from trace length and sampling rate.
 * Each element is `i / samplingRate` (seconds).
 */
export function makeTimeAxis(length: number, samplingRate: number): Float64Array {
  const dt = 1 / samplingRate;
  const x = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    x[i] = i * dt;
  }
  return x;
}
