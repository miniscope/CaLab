/**
 * Fixed display ranges of the exported field-of-view images (export format 4).
 *
 * No auto-contrast: an image is drawn linearly over a range fixed by the
 * recording's bit depth, never by its pixels, so a dimmer session looks
 * dimmer and a brighter one brighter. Full scale is `2^bits - 1` grey levels
 * (255 for the 8-bit Miniscope V4).
 *
 *   mean (registered, before background removal): 0 .. full scale, the whole
 *        range the sensor can record;
 *   max (background removed): 0 .. full scale / MAX_DIVISOR. Removing the
 *        floor leaves the cells' rise above it, a fraction of full scale.
 *
 * The export stores the range it was written with (`meta_json.fov_images`),
 * and the viewer draws with the stored range, so a later change here does not
 * change how an old export looks. The lo/hi inputs over the image still set a
 * range by hand.
 */
import type { DisplayRange } from './frame-display.ts';

/** Full scale over this is the max image's top. */
export const MAX_DIVISOR = 4;

export interface FovDisplayRanges {
  fullScale: number;
  mean: [number, number];
  max: [number, number];
}

export function fovDisplayRanges(bitDepth: number): FovDisplayRanges {
  const bits = Number.isFinite(bitDepth) && bitDepth > 0 ? Math.round(bitDepth) : 8;
  const fullScale = 2 ** bits - 1;
  return { fullScale, mean: [0, fullScale], max: [0, fullScale / MAX_DIVISOR] };
}

/** A stored `[lo, hi]` as a display range (null when it is not a usable range). */
export function storedRange(v: unknown): DisplayRange | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lo, hi] = v.map(Number);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { lo, hi } : null;
}
