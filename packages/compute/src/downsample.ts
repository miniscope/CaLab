/**
 * Min/max per-pixel-bucket downsampling for large time series.
 * Preserves true spike peaks and troughs (not LTTB which smooths aesthetically).
 * Standard approach for oscilloscope-style scientific waveform displays.
 */

/**
 * Reduce data to at most 2 * targetBuckets points by computing min and max
 * values within each bucket. Pushes min/max in time order to preserve waveform shape.
 *
 * Non-finite samples (NaN, ±Infinity) are ignored when picking a bucket's
 * min/max. A bucket with no finite sample emits two `null`s (a uPlot gap) at
 * the bucket's first and last x, so every bucket still contributes exactly two
 * points and series downsampled over the same x stay the same length. When no
 * downsampling is needed, non-finite samples are likewise returned as `null`.
 *
 * Each bucket's min/max order follows that series' own data, so the i-th
 * outputs of two independently downsampled series need not come from the same
 * sample. Never combine downsampled series element-wise (e.g. a residual):
 * derive the combined series at full resolution and downsample the result.
 *
 * @param xData - Time axis values (typed array or number[])
 * @param yData - Trace values (typed array or number[])
 * @param targetBuckets - Number of pixel-width buckets (typically chart width in px)
 * @returns [xValues, yValues] suitable for uPlot
 */
export function downsampleMinMax(
  xData: ArrayLike<number>,
  yData: ArrayLike<number>,
  targetBuckets: number,
): [number[], (number | null)[]] {
  const len = xData.length;

  // No downsampling needed. y is still copied so non-finite samples become
  // gaps (uPlot's autoscale is poisoned by NaN/Infinity).
  if (len <= targetBuckets * 2) {
    const outY: (number | null)[] = new Array(len);
    for (let i = 0; i < len; i++) {
      const v = yData[i];
      outY[i] = Number.isFinite(v) ? v : null;
    }
    return [Array.from(xData), outY];
  }

  const bucketSize = len / targetBuckets;
  const outX: number[] = [];
  const outY: (number | null)[] = [];

  for (let i = 0; i < targetBuckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(Math.floor((i + 1) * bucketSize), len);

    let min = Infinity;
    let max = -Infinity;
    let minIdx = -1;
    let maxIdx = -1;

    for (let j = start; j < end; j++) {
      const v = yData[j];
      if (!Number.isFinite(v)) continue;
      if (v < min) {
        min = v;
        minIdx = j;
      }
      if (v > max) {
        max = v;
        maxIdx = j;
      }
    }

    if (minIdx < 0) {
      // No finite sample in this bucket: emit a gap rather than ±Infinity.
      outX.push(xData[start], xData[end - 1]);
      outY.push(null, null);
    } else if (minIdx <= maxIdx) {
      // Push min and max in time order to preserve shape
      outX.push(xData[minIdx], xData[maxIdx]);
      outY.push(min, max);
    } else {
      outX.push(xData[maxIdx], xData[minIdx]);
      outY.push(max, min);
    }
  }

  return [outX, outY];
}
