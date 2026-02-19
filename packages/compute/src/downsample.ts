/**
 * Min/max per-pixel-bucket downsampling for large time series.
 * Preserves true spike peaks and troughs (not LTTB which smooths aesthetically).
 * Standard approach for oscilloscope-style scientific waveform displays.
 */

/**
 * Reduce data to at most 2 * targetBuckets points by computing min and max
 * values within each bucket. Pushes min/max in time order to preserve waveform shape.
 *
 * @param xData - Time axis values (Float64Array or number[])
 * @param yData - Trace values (Float64Array or number[])
 * @param targetBuckets - Number of pixel-width buckets (typically chart width in px)
 * @returns [xValues, yValues] suitable for uPlot
 */
export function downsampleMinMax(
  xData: Float64Array | Float32Array | number[],
  yData: Float64Array | Float32Array | number[],
  targetBuckets: number,
): [number[], number[]] {
  const len = xData.length;

  // No downsampling needed
  if (len <= targetBuckets * 2) {
    return [Array.from(xData), Array.from(yData)];
  }

  const bucketSize = len / targetBuckets;
  const outX: number[] = [];
  const outY: number[] = [];

  for (let i = 0; i < targetBuckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(Math.floor((i + 1) * bucketSize), len);

    let min = Infinity;
    let max = -Infinity;
    let minIdx = start;
    let maxIdx = start;

    for (let j = start; j < end; j++) {
      const v = yData[j] as number;
      if (v < min) {
        min = v;
        minIdx = j;
      }
      if (v > max) {
        max = v;
        maxIdx = j;
      }
    }

    // Push min and max in time order to preserve shape
    if (minIdx <= maxIdx) {
      outX.push(xData[minIdx] as number, xData[maxIdx] as number);
      outY.push(min, max);
    } else {
      outX.push(xData[maxIdx] as number, xData[minIdx] as number);
      outY.push(max, min);
    }
  }

  return [outX, outY];
}
