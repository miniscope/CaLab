/**
 * Fixed display ranges of the exported field-of-view images (export format 5).
 *
 * No auto-contrast: an image is drawn linearly over a range fixed by the
 * recording's bit depth, never by its pixels, so a dimmer session looks
 * dimmer and a brighter one brighter. Full scale is `2^bits - 1` grey levels
 * (255 for the 8-bit Miniscope V4).
 *
 *   mean (registered, before background removal): -full scale / 32 ..
 *        full scale / 8 (-8 .. 32 grey levels at 8 bits). Preprocessing has
 *        already flattened the glow, so the frame sits near 0 and its
 *        structure (vessels, cells, the edge of the lens) spans tens of grey
 *        levels, not the sensor's whole range;
 *   max (background removed): 0 .. full scale / 4 (0 .. 64 at 8 bits): the
 *        cells' rise above the floor.
 *
 * Measured on minisim motion_s6 (8-bit, 1000 frames): the mean spans -14 .. 54
 * (1st-99th percentile -7 .. 20), the max 0 .. 108 (99th percentile 40).
 *
 * The export stores the range it was written with (`meta_json.fov_images`),
 * and the viewer draws with the stored range, so a later change here does not
 * change how an old export looks. The lo/hi inputs over the image still set a
 * range by hand.
 */
import type { DisplayRange } from './frame-display.ts';

/** The ranges as fractions of full scale: mean [lo, hi], max [lo, hi]. */
export const MEAN_RANGE_FS: readonly [number, number] = [-1 / 32, 1 / 8];
export const MAX_RANGE_FS: readonly [number, number] = [0, 1 / 4];

export interface FovDisplayRanges {
  fullScale: number;
  mean: [number, number];
  max: [number, number];
}

export function fovDisplayRanges(bitDepth: number): FovDisplayRanges {
  const bits = Number.isFinite(bitDepth) && bitDepth > 0 ? Math.round(bitDepth) : 8;
  const fullScale = 2 ** bits - 1;
  const at = (r: readonly [number, number]): [number, number] => [
    r[0] * fullScale,
    r[1] * fullScale,
  ];
  return { fullScale, mean: at(MEAN_RANGE_FS), max: at(MAX_RANGE_FS) };
}

/** A stored `[lo, hi]` as a display range (null when it is not a usable range). */
export function storedRange(v: unknown): DisplayRange | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lo, hi] = v.map(Number);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { lo, hi } : null;
}
