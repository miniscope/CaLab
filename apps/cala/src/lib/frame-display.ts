/** Map raw frame bytes to 8-bit display gray levels. Pure, so it is unit-tested. */

import type { FramePixels } from './frame-source.ts';

/** Integer frames from the source, or float images from the pipeline. */
export type DisplayPixels = FramePixels | Float32Array;

/** Gray levels as opaque RGBA pixels for `putImageData`. */
export function grayToImageData(gray: Uint8ClampedArray, width: number, height: number): ImageData {
  const rgba = new ImageData(width, height);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    const o = 4 * i;
    rgba.data[o] = v;
    rgba.data[o + 1] = v;
    rgba.data[o + 2] = v;
    rgba.data[o + 3] = 255;
  }
  return rgba;
}

const HIST_BINS = 1024;
/** Fraction of pixels clipped at each end by auto contrast. */
const CLIP_FRACTION = 0.005;

export interface DisplayRange {
  lo: number;
  hi: number;
}

/** Number of pixels in a frame buffer of the given depth. */
export function pixelCount(pixels: DisplayPixels, _bitDepth?: number): number {
  return pixels.length;
}

function valueAt(pixels: DisplayPixels, _bitDepth: number, i: number): number {
  return pixels[i];
}

/**
 * Display range: the full sample range, or with `auto` the 0.5%-99.5%
 * percentiles (so a few hot pixels or vignetting do not flatten the image).
 */
export function displayRange(bytes: DisplayPixels, bitDepth: number, auto: boolean): DisplayRange {
  const fullHi = bitDepth === 16 ? 65535 : 255;
  const n = pixelCount(bytes, bitDepth);
  if (!auto || n === 0) return { lo: 0, hi: fullHi };

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = valueAt(bytes, bitDepth, i);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max <= min) return { lo: min, hi: min + 1 };

  const scale = (HIST_BINS - 1) / (max - min);
  const hist = new Uint32Array(HIST_BINS);
  for (let i = 0; i < n; i++) hist[Math.floor((valueAt(bytes, bitDepth, i) - min) * scale)]++;

  const clip = n * CLIP_FRACTION;
  let acc = 0;
  let loBin = 0;
  for (; loBin < HIST_BINS - 1; loBin++) {
    acc += hist[loBin];
    if (acc > clip) break;
  }
  acc = 0;
  let hiBin = HIST_BINS - 1;
  for (; hiBin > loBin; hiBin--) {
    acc += hist[hiBin];
    if (acc > clip) break;
  }
  const lo = min + loBin / scale;
  const hi = min + (hiBin + 1) / scale;
  return { lo, hi: Math.max(hi, lo + 1) };
}

/** Images pooled for the one-time range fit (one preview image per batch). */
export const FIT_FRAMES = 8;
/** Pixels sampled per image for the range fit. */
const FIT_SAMPLES = 4096;

/** Evenly strided subsample of at most `max` finite values. */
export function subsamplePixels(pixels: DisplayPixels, max = FIT_SAMPLES): Float32Array {
  const stride = Math.max(1, Math.floor(pixels.length / max));
  const out: number[] = [];
  for (let i = 0; i < pixels.length; i += stride) {
    const v = pixels[i];
    if (Number.isFinite(v)) out.push(v);
  }
  return Float32Array.from(out);
}

/** Robust (0.5%-99.5%) range of pooled samples; null when there are none. */
export function percentileRange(samples: Float32Array[]): DisplayRange | null {
  let n = 0;
  for (const s of samples) n += s.length;
  if (n === 0) return null;
  const all = new Float32Array(n);
  let o = 0;
  for (const s of samples) {
    all.set(s, o);
    o += s.length;
  }
  all.sort();
  const lo = all[Math.floor(CLIP_FRACTION * (n - 1))];
  const hi = all[Math.ceil((1 - CLIP_FRACTION) * (n - 1))];
  return { lo, hi: Math.max(hi, lo + 1e-6 * Math.max(1, Math.abs(lo))) };
}

/**
 * A display range that never adapts on its own. It is fitted once, from
 * robust percentiles pooled over the first `fitFrames` images, then held
 * until a manual change, an explicit re-fit, or a reset (new run). Pixels
 * outside it clip, so a real change in contrast or amplitude stays visible.
 */
export class RangeHold {
  private recent: Float32Array[] = [];
  private pooled: Float32Array[] = [];
  private held = false;
  private current: DisplayRange | null = null;

  constructor(private readonly fitFrames = FIT_FRAMES) {}

  /** Current range; null before the first image. */
  get range(): DisplayRange | null {
    return this.current;
  }

  /** True once the range is held (fit complete, or set by hand). */
  get locked(): boolean {
    return this.held;
  }

  /** Feed an image shown in this panel; returns the range to draw it with. */
  observe(pixels: DisplayPixels): DisplayRange | null {
    const sample = subsamplePixels(pixels);
    this.recent.push(sample);
    if (this.recent.length > this.fitFrames) this.recent.shift();
    if (this.held) return this.current;
    this.pooled.push(sample);
    this.current = percentileRange(this.pooled);
    if (this.pooled.length >= this.fitFrames) this.held = true;
    return this.current;
  }

  /** Hold a manually chosen range. */
  setManual(range: DisplayRange): void {
    if (!(range.hi > range.lo)) return;
    this.current = { lo: range.lo, hi: range.hi };
    this.held = true;
  }

  /** Recompute once from the most recent images, then hold again. */
  refit(): void {
    const r = percentileRange(this.recent);
    if (!r) return;
    this.current = r;
    this.held = true;
  }

  /** Forget everything (new run, restart, or a different view). */
  reset(): void {
    this.recent = [];
    this.pooled = [];
    this.held = false;
    this.current = null;
  }
}

/** One gray byte per pixel for `bytes`, linearly mapped from `range` to 0-255. */
export function toGray8(
  bytes: DisplayPixels,
  bitDepth: number,
  range: DisplayRange,
): Uint8ClampedArray {
  const n = pixelCount(bytes, bitDepth);
  const out = new Uint8ClampedArray(n);
  const k = 255 / (range.hi - range.lo);
  for (let i = 0; i < n; i++) out[i] = (valueAt(bytes, bitDepth, i) - range.lo) * k;
  return out;
}
