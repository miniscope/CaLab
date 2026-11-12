/**
 * Field-of-view summaries of the preprocessor's state for the History view:
 * the median per-pixel noise σ (CaLab's SNR convention, the MAD of
 * frame-to-frame differences, see `crates/cala/src/preprocess/noise.rs`) and
 * the median background floor, both in grey levels over the FOV mask.
 *
 * Read about once per `IMAGING_EVERY_FRAMES` frames: the maps are copied out
 * of WASM (4 bytes per pixel each) and a strided subsample's median is taken,
 * which costs about a millisecond at 600 x 600.
 */

/** Frames between imaging summaries (about one per second of stream at 20-60 fps). */
export const IMAGING_EVERY_FRAMES = 32;

/** Pixels sampled per summary at most (a regular stride over the image). */
const MAX_SAMPLES = 16384;

/** The two summaries, at the batch's last frame. */
export interface ImagingStats {
  /** Stream frame the summaries describe (the batch's last). */
  frame: number;
  /** Median per-pixel noise σ over the FOV, grey levels. */
  noiseSigma: number;
  /** Median background floor over the FOV, grey levels. */
  background: number;
}

/** What the preprocessor exposes (a `Preprocessor` from the WASM package). */
export interface ImagingSource {
  noiseSigma(): Float32Array;
  background(): Float32Array;
}

/** In-place quickselect: the k-th smallest of `a[0..n)`. */
function select(a: Float32Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/** Median of the finite values of `map` inside `mask` (all pixels when null), on a regular stride. */
export function maskedMedian(
  map: Float32Array,
  mask: Uint8Array | null,
  scratch?: Float32Array,
): number {
  const stride = Math.max(1, Math.floor(map.length / MAX_SAMPLES));
  const buf =
    scratch && scratch.length >= Math.ceil(map.length / stride)
      ? scratch
      : new Float32Array(Math.ceil(map.length / stride));
  let n = 0;
  for (let i = 0; i < map.length; i += stride) {
    if (mask && !mask[i]) continue;
    const v = map[i];
    if (Number.isFinite(v)) buf[n++] = v;
  }
  if (n === 0) return NaN;
  return select(buf, n, n >> 1);
}

/** Summaries now, every `IMAGING_EVERY_FRAMES` frames of the stream (undefined in between). */
export class ImagingSampler {
  private next = 0;
  private scratch: Float32Array | undefined;

  constructor(private readonly mask: () => Uint8Array | null) {}

  /** Call once per processed batch (frames `start..start+count`); returns summaries when one is due. */
  sample(src: ImagingSource, start: number, count: number): ImagingStats | undefined {
    const end = start + count;
    if (end < this.next) return undefined;
    this.next = end + IMAGING_EVERY_FRAMES;
    const mask = this.mask();
    const noise = src.noiseSigma();
    this.scratch ??= new Float32Array(
      Math.ceil(noise.length / Math.max(1, Math.floor(noise.length / MAX_SAMPLES))),
    );
    return {
      frame: end - 1,
      noiseSigma: maskedMedian(noise, mask, this.scratch),
      background: maskedMedian(src.background(), mask, this.scratch),
    };
  }
}
