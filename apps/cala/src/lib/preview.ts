/** Small preview images of full frames, for the live view. Pure. */

export interface PreviewImage {
  width: number;
  height: number;
  /** Row-major, `width * height` values. */
  data: Float32Array;
}

/** Integer box-downsampling factor so the longer side is at most `maxSide`. */
export function previewFactor(width: number, height: number, maxSide: number): number {
  return Math.max(1, Math.ceil(Math.max(width, height) / Math.max(1, maxSide)));
}

/**
 * Box-average frame `index` of a contiguous batch (`width * height` values
 * per frame) by an integer factor. Edge blocks average only the pixels they
 * cover. Non-finite values are skipped.
 */
export function downsampleFrame(
  batch: ArrayLike<number>,
  index: number,
  width: number,
  height: number,
  factor: number,
): PreviewImage {
  const f = Math.max(1, Math.floor(factor));
  const ow = Math.ceil(width / f);
  const oh = Math.ceil(height / f);
  const sum = new Float32Array(ow * oh);
  const cnt = new Uint32Array(ow * oh);
  const base = index * width * height;
  for (let y = 0; y < height; y++) {
    const orow = Math.floor(y / f) * ow;
    const irow = base + y * width;
    for (let x = 0; x < width; x++) {
      const v = batch[irow + x];
      if (!Number.isFinite(v)) continue;
      const o = orow + Math.floor(x / f);
      sum[o] += v;
      cnt[o]++;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i] > 0 ? sum[i] / cnt[i] : 0;
  return { width: ow, height: oh, data: sum };
}

/**
 * Take the fast loop's full-frame residual off a batch result (it must not
 * travel to the main thread at full size) and return it as a preview.
 */
export function takeResidualPreview(
  cells: { residual?: Float32Array } | undefined,
  width: number,
  height: number,
  factor: number,
): PreviewImage | undefined {
  const r = cells?.residual;
  if (!cells || !r) return undefined;
  delete cells.residual;
  return downsampleFrame(r, 0, width, height, factor);
}
