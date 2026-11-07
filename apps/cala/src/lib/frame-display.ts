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
