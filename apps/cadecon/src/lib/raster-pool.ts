// Max-pooling for the raster heatmap. Each output cell aggregates every source
// (cell, time) sample that maps into it, so a single active cell or a brief
// transient is never dropped by down-sampling. Values are normalized bytes
// (0..255); max is taken after normalization, which is monotonic so the result
// matches normalizing the max.

/** Map index i in [0, n) onto bin [0, bins). Every bin receives >=1 index when bins <= n. */
function binMap(n: number, bins: number): Int32Array {
  const m = new Int32Array(n);
  for (let i = 0; i < n; i++) m[i] = Math.min(bins - 1, Math.floor((i * bins) / n));
  return m;
}

/** Normalize one raw value to a byte; non-finite maps to 0. */
export function normalizeByte(v: number, p1: number, range: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(((v - p1) / range) * 255)));
}

/**
 * Pool the raw trace matrix (N cells x T frames) into outRows x outCols bytes
 * in a single pass. `rawCols` is the stored row length; when `swapped` the raw
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
  p1: number,
  range: number,
): { out: Uint8Array; rows: number; cols: number } {
  const rows = Math.max(1, Math.min(N, Math.floor(outRows)));
  const cols = Math.max(1, Math.min(T, Math.floor(outCols)));
  const out = new Uint8Array(rows * cols);
  const rowOf = binMap(N, rows);
  const colOf = binMap(T, cols);
  if (swapped) {
    // frames-major: iterate t outer, cell inner for contiguous reads
    for (let t = 0; t < T; t++) {
      const base = t * rawCols;
      const c = colOf[t];
      for (let n = 0; n < N; n++) {
        const b = normalizeByte(data[base + n], p1, range);
        const o = rowOf[n] * cols + c;
        if (b > out[o]) out[o] = b;
      }
    }
  } else {
    for (let n = 0; n < N; n++) {
      const base = n * rawCols;
      const rowBase = rowOf[n] * cols;
      for (let t = 0; t < T; t++) {
        const b = normalizeByte(data[base + t], p1, range);
        const o = rowBase + colOf[t];
        if (b > out[o]) out[o] = b;
      }
    }
  }
  return { out, rows, cols };
}

/** Max-pool an already-normalized byte matrix to a smaller (or equal) size. */
export function poolBytesMax(
  src: Uint8Array,
  rows: number,
  cols: number,
  outRows: number,
  outCols: number,
): { out: Uint8Array; rows: number; cols: number } {
  const r = Math.max(1, Math.min(rows, Math.floor(outRows)));
  const c = Math.max(1, Math.min(cols, Math.floor(outCols)));
  if (r === rows && c === cols) return { out: src, rows, cols };
  const out = new Uint8Array(r * c);
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
  return { out, rows: r, cols: c };
}
