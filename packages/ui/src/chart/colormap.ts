// Shared perceptual colormaps for heatmaps (raster overviews, spatial maps, ...).
// Kept in @calab/ui so every app renders intensity data with the same LUT.

/**
 * Build a 256-entry RGB lookup table by linearly interpolating a set of
 * anchor stops. Returns a Uint8Array of length 256*3 (r,g,b per entry).
 */
function buildLUT(stops: readonly (readonly [number, number, number])[]): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const idx = Math.floor(t);
    const frac = t - idx;
    const a = stops[Math.min(idx, stops.length - 1)];
    const b = stops[Math.min(idx + 1, stops.length - 1)];
    lut[i * 3] = Math.round(a[0] + (b[0] - a[0]) * frac);
    lut[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * frac);
    lut[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * frac);
  }
  return lut;
}

// Viridis anchor stops (dark purple → teal → yellow): perceptually uniform and
// colorblind-friendly, the standard scientific sequential colormap.
const VIRIDIS_STOPS = [
  [68, 1, 84],
  [72, 35, 116],
  [64, 67, 135],
  [52, 94, 141],
  [41, 120, 142],
  [32, 144, 140],
  [34, 167, 132],
  [68, 190, 112],
  [121, 209, 81],
  [189, 222, 38],
  [253, 231, 37],
] as const;

/** 256-entry viridis RGB lookup table (length 256*3). */
export const VIRIDIS_LUT = buildLUT(VIRIDIS_STOPS);

/** Map a normalized value in [0,1] to a viridis [r,g,b] triple (clamped). */
export function viridisRGB(t: number): [number, number, number] {
  const i = Math.max(0, Math.min(255, Math.round(t * 255)));
  return [VIRIDIS_LUT[i * 3], VIRIDIS_LUT[i * 3 + 1], VIRIDIS_LUT[i * 3 + 2]];
}

/** Map a normalized value in [0,1] to a viridis CSS `rgb(...)` string. */
export function viridisCss(t: number): string {
  const [r, g, b] = viridisRGB(t);
  return `rgb(${r}, ${g}, ${b})`;
}
