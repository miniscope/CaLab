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
  const data = new Float32Array(ow * oh);
  downsampleInto(batch, index, width, height, f, data, 0, new Uint32Array(ow * oh));
  return { width: ow, height: oh, data };
}

/** Box-average frame `index` into `out[offset ..]`; `cnt` is scratch of `out`'s frame size. */
function downsampleInto(
  batch: ArrayLike<number>,
  index: number,
  width: number,
  height: number,
  f: number,
  out: Float32Array,
  offset: number,
  cnt: Uint32Array,
): void {
  const ow = Math.ceil(width / f);
  const n = ow * Math.ceil(height / f);
  cnt.fill(0);
  const base = index * width * height;
  for (let y = 0; y < height; y++) {
    const orow = offset + Math.floor(y / f) * ow;
    const irow = base + y * width;
    for (let x = 0; x < width; x++) {
      const v = batch[irow + x];
      if (!Number.isFinite(v)) continue;
      const o = orow + Math.floor(x / f);
      out[o] += v;
      cnt[o - offset]++;
    }
  }
  for (let i = 0; i < n; i++) out[offset + i] = cnt[i] > 0 ? out[offset + i] / cnt[i] : 0;
}

/** The views a batch can carry a preview of for every frame. */
export type FrameView = 'raw' | 'preprocessed' | 'corrected' | 'output';

/**
 * Previews of every frame of a batch, one view: `count` images of
 * `width * height` values, back to back (one buffer per batch, so it is
 * transferred, not copied per frame). Drives smooth playback (`playback.ts`).
 */
export interface FramePreviews {
  view: FrameView;
  /** Stream index of the first frame. */
  first: number;
  count: number;
  width: number;
  height: number;
  data: Float32Array;
}

/** `downsampleFrame` for frames `0 .. count-1` of a batch, in one buffer (same values frame by frame). */
export function downsampleFrames(
  batch: ArrayLike<number>,
  count: number,
  width: number,
  height: number,
  factor: number,
  view: FrameView,
  first: number,
): FramePreviews {
  const f = Math.max(1, Math.floor(factor));
  const ow = Math.ceil(width / f);
  const oh = Math.ceil(height / f);
  const data = new Float32Array(count * ow * oh);
  const cnt = new Uint32Array(ow * oh);
  for (let i = 0; i < count; i++)
    downsampleInto(batch, i, width, height, f, data, i * ow * oh, cnt);
  return { view, first, count, width: ow, height: oh, data };
}

/** Frame `i` of a `FramePreviews` as an image (a view into the buffer, no copy). */
export function framePreviewImage(fp: FramePreviews, i: number): PreviewImage {
  const n = fp.width * fp.height;
  return { width: fp.width, height: fp.height, data: fp.data.subarray(i * n, (i + 1) * n) };
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
