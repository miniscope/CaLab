// Max-pooling for the raster heatmap. Each output cell aggregates every source
// (cell, time) sample that maps into it, so a single active cell or a brief
// transient is never dropped by down-sampling.
//
// Pooling happens in the raw-value domain. Colour bounds are then derived from
// the POOLED values (see pooledBounds): the max over many noise samples sits
// well above the raw mean, so bounds taken from raw samples would saturate the
// pooled noise. Against pooled bounds the noise becomes a narrow dark floor and
// transients stand out.

/** Temporal smoothing window, seconds: shorter than a calcium transient's rise plus peak. */
export const SMOOTH_WINDOW_SECONDS = 0.1;
/** Nominal plot width (physical px) used to estimate the pooling factor along time. */
export const NOMINAL_PLOT_COLS = 1600;
/** Percentiles of the pooled image mapped to the bottom and top of the colormap. */
export const POOLED_LOW_Q = 0.05;
export const POOLED_HIGH_Q = 0.995;

/**
 * Moving-average width (frames) applied along time before max-pooling.
 * Averaging w frames cuts white-noise sigma by ~sqrt(w) before the max.
 * w = min(frames per pixel, SMOOTH_WINDOW_SECONDS * fs), so no smoothing happens
 * when there is no pooling, and a transient longer than the window keeps its peak.
 */
export function smoothWidthFrames(T: number, fs: number | null | undefined): number {
  if (!fs || !(fs > 0)) return 1;
  const pooling = Math.floor(T / NOMINAL_PLOT_COLS);
  return Math.max(1, Math.min(pooling, Math.round(SMOOTH_WINDOW_SECONDS * fs)));
}

/** Map index i in [0, n) onto bin [0, bins). Every bin receives >=1 index when bins <= n. */
function binMap(n: number, bins: number): Int32Array {
  const m = new Int32Array(n);
  for (let i = 0; i < n; i++) m[i] = Math.min(bins - 1, Math.floor((i * bins) / n));
  return m;
}

/** Normalize one value to a byte; non-finite maps to 0. */
export function normalizeByte(v: number, lo: number, range: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(((v - lo) / range) * 255)));
}

/** Low/high percentile bounds of a pooled image (sampled to <=100k values). */
export function pooledBounds(
  pooled: ArrayLike<number>,
  lowQ = POOLED_LOW_Q,
  highQ = POOLED_HIGH_Q,
): { lo: number; hi: number; range: number } {
  const step = Math.max(1, Math.floor(pooled.length / 100000));
  const s: number[] = [];
  for (let i = 0; i < pooled.length; i += step) if (Number.isFinite(pooled[i])) s.push(pooled[i]);
  if (s.length === 0) return { lo: 0, hi: 1, range: 1 };
  s.sort((a, b) => a - b);
  const lo = s[Math.min(s.length - 1, Math.floor(s.length * lowQ))];
  const hi = s[Math.min(s.length - 1, Math.floor(s.length * highQ))];
  return { lo, hi, range: hi - lo || 1 };
}

/**
 * Pool the raw trace matrix (N cells x T frames) into outRows x outCols raw
 * values in a single pass, optionally moving-averaging along time first (running
 * sum, window truncated at the edges). Non-finite samples are ignored (a bin
 * with none is NaN). `rawCols` is the stored row length; when `swapped` the raw
 * layout is frames-major (index = t * rawCols + cell). outRows/outCols are
 * clamped to [1, N] / [1, T] (never upsamples).
 */
export function poolRawMax(
  data: ArrayLike<number>,
  rawCols: number,
  swapped: boolean,
  N: number,
  T: number,
  outRows: number,
  outCols: number,
  smoothWidth = 1,
): { out: Float32Array; rows: number; cols: number } {
  const w = Math.max(1, Math.floor(smoothWidth));
  const rows = Math.max(1, Math.min(N, Math.floor(outRows)));
  const cols = Math.max(1, Math.min(T, Math.floor(outCols)));
  const out = new Float32Array(rows * cols).fill(-Infinity);
  const rowOf = binMap(N, rows);
  const colOf = binMap(T, cols);
  // Non-finite samples read as 0 inside the moving average and are skipped by max.
  const val = (x: number) => (Number.isFinite(x) ? x : 0);

  if (w === 1) {
    if (swapped) {
      // frames-major: iterate t outer, cell inner for contiguous reads
      for (let t = 0; t < T; t++) {
        const base = t * rawCols;
        const c = colOf[t];
        for (let n = 0; n < N; n++) {
          const v = data[base + n];
          const o = rowOf[n] * cols + c;
          if (v > out[o]) out[o] = v;
        }
      }
    } else {
      for (let n = 0; n < N; n++) {
        const base = n * rawCols;
        const rowBase = rowOf[n] * cols;
        for (let t = 0; t < T; t++) {
          const v = data[base + t];
          const o = rowBase + colOf[t];
          if (v > out[o]) out[o] = v;
        }
      }
    }
  } else {
    const lo = Math.floor(w / 2);
    const hi = w - 1 - lo;
    if (swapped) {
      const sum = new Float64Array(N);
      for (let t = 0; t <= Math.min(hi, T - 1); t++) {
        const base = t * rawCols;
        for (let n = 0; n < N; n++) sum[n] += val(data[base + n]);
      }
      for (let c = 0; c < T; c++) {
        const count = Math.min(T - 1, c + hi) - Math.max(0, c - lo) + 1;
        const col = colOf[c];
        const addT = c + hi + 1;
        const subT = c - lo;
        const addBase = addT * rawCols;
        const subBase = subT * rawCols;
        for (let n = 0; n < N; n++) {
          const v = sum[n] / count;
          const o = rowOf[n] * cols + col;
          if (v > out[o]) out[o] = v;
          if (addT < T) sum[n] += val(data[addBase + n]);
          if (subT >= 0) sum[n] -= val(data[subBase + n]);
        }
      }
    } else {
      for (let n = 0; n < N; n++) {
        const base = n * rawCols;
        const rowBase = rowOf[n] * cols;
        let sum = 0;
        for (let t = 0; t <= Math.min(hi, T - 1); t++) sum += val(data[base + t]);
        for (let c = 0; c < T; c++) {
          const count = Math.min(T - 1, c + hi) - Math.max(0, c - lo) + 1;
          const v = sum / count;
          const o = rowBase + colOf[c];
          if (v > out[o]) out[o] = v;
          if (c + hi + 1 < T) sum += val(data[base + c + hi + 1]);
          if (c - lo >= 0) sum -= val(data[base + c - lo]);
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] === -Infinity) out[i] = NaN;
  return { out, rows, cols };
}

/** Max-pool an already pooled matrix to a smaller (or equal) size. */
export function poolMatrixMax(
  src: Float32Array,
  rows: number,
  cols: number,
  outRows: number,
  outCols: number,
): { out: Float32Array; rows: number; cols: number } {
  const r = Math.max(1, Math.min(rows, Math.floor(outRows)));
  const c = Math.max(1, Math.min(cols, Math.floor(outCols)));
  if (r === rows && c === cols) return { out: src, rows, cols };
  const out = new Float32Array(r * c).fill(-Infinity);
  const rowOf = binMap(rows, r);
  const colOf = binMap(cols, c);
  for (let y = 0; y < rows; y++) {
    const sBase = y * cols;
    const oBase = rowOf[y] * c;
    for (let x = 0; x < cols; x++) {
      const v = src[sBase + x];
      const o = oBase + colOf[x];
      if (v > out[o]) out[o] = v;
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] === -Infinity) out[i] = NaN;
  return { out, rows: r, cols: c };
}
