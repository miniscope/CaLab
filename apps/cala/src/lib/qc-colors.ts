/**
 * Colours of the cell overlay by QC metric or status, and the residual-map
 * heat layer. Pure, unit-tested (the colour ramp of the continuous modes is
 * passed in, viridis in the app).
 */
import type { Rgb } from './cell-overlay.ts';
import { FLAG_UNMEASURED, type CellQcRow, type ResidualMap } from './qc.ts';

export type ColorMode = 'found' | 'status' | 'pass' | 'peakSnr' | 'projR' | 'vif' | 'fpError';

export interface ColorModeInfo {
  label: string;
  /** Shown next to the legend: whether this is a validated judgement. */
  note: string;
}

export const COLOR_MODES: Record<ColorMode, ColorModeInfo> = {
  found: { label: 'When found', note: '' },
  status: { label: 'Slow-loop status', note: 'probation until enough transients' },
  pass: { label: 'QC pass / fail', note: 'SNR >= 5, not a likely duplicate' },
  peakSnr: { label: 'Peak SNR', note: 'drives pass/fail' },
  projR: { label: 'Trace fidelity (proj r)', note: 'validated score, no threshold' },
  vif: { label: 'Crosstalk (vif)', note: 'expected crosstalk from overlap' },
  fpError: { label: 'Footprint error', note: 'colour scale only, no threshold' },
};

/** Fixed scales of the continuous modes: value at the low and high end of viridis. */
export const METRIC_SCALE: Record<'peakSnr' | 'projR' | 'vif', { lo: number; hi: number }> = {
  peakSnr: { lo: 0, hi: 20 },
  projR: { lo: 0, hi: 1 },
  vif: { lo: 1, hi: 3 },
};

export const PASS_RGB: Rgb = [0x00, 0x9e, 0x73]; // Okabe-Ito bluish green
export const FAIL_RGB: Rgb = [0xd5, 0x5e, 0x00]; // vermillion
export const PROBATION_RGB: Rgb = [0xe6, 0x9f, 0x00]; // orange
export const ESTABLISHED_RGB: Rgb = [0x56, 0xb4, 0xe9]; // sky blue
export const UNKNOWN_RGB: Rgb = [0x8c, 0x8c, 0x8c];

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** The scale of `fpError` follows the data (its 5th to 95th percentile): it has no absolute meaning. */
export function fpErrorScale(rows: readonly CellQcRow[]): { lo: number; hi: number } {
  const v = rows
    .map((r) => r.fpError)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (v.length === 0) return { lo: 0, hi: 1 };
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  const lo = q(0.05);
  const hi = q(0.95);
  return { lo, hi: hi > lo ? hi : lo + 1 };
}

/**
 * Colour of a cell in a QC mode. `scale` is the continuous mode's range;
 * `established` is the slow loop's status (undefined = unknown). A metric
 * mode uses grey for cells not measured yet.
 */
export function qcColor(
  mode: Exclude<ColorMode, 'found'>,
  row: CellQcRow | undefined,
  established: boolean | undefined,
  scale: { lo: number; hi: number },
  ramp: (t: number) => Rgb,
): Rgb {
  if (mode === 'status') {
    if (established === undefined) return UNKNOWN_RGB;
    return established ? ESTABLISHED_RGB : PROBATION_RGB;
  }
  if (!row || row.flags & FLAG_UNMEASURED) return UNKNOWN_RGB;
  if (mode === 'pass') return row.pass ? PASS_RGB : FAIL_RGB;
  const v = row[mode];
  if (!Number.isFinite(v)) return UNKNOWN_RGB;
  return ramp(clamp01((v - scale.lo) / (scale.hi - scale.lo)));
}

/** Range of a metric mode (fixed, or from the data for fpError). */
export function modeScale(mode: ColorMode, rows: readonly CellQcRow[]): { lo: number; hi: number } {
  if (mode === 'fpError') return fpErrorScale(rows);
  if (mode === 'peakSnr' || mode === 'projR' || mode === 'vif') return METRIC_SCALE[mode];
  return { lo: 0, hi: 1 };
}

/**
 * Top of the residual-map colour scale: the 98th percentile of the map (in
 * noise variances above 1), so the hottest blocks stand out whatever the
 * overall level (real data keep a lot of unmodelled neuropil).
 */
export function residualMax(map: ResidualMap): number {
  const v = Array.from(map.values)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (v.length === 0) return 1;
  return Math.max(0.1, v[Math.min(v.length - 1, Math.floor(0.98 * (v.length - 1)))]);
}

/** Black-red-yellow ramp with opacity rising from 0 (only noise left) to `max`. */
function heat(t: number): [number, number, number, number] {
  const u = clamp01(t);
  const r = 255 * clamp01(u * 2);
  const g = 255 * clamp01(u * 2 - 1);
  const b = 40 * clamp01(u * 3 - 2);
  return [r, g, b, Math.round(255 * Math.min(0.7, u))];
}

/**
 * RGBA of the residual map (one pixel per block), on a log scale from 0
 * (only noise left: transparent) to `max`; NaN blocks are transparent.
 */
export function residualRgba(map: ResidualMap, max = residualMax(map)): Uint8ClampedArray {
  const n = map.blocksWide * map.blocksHigh;
  const out = new Uint8ClampedArray(n * 4);
  const top = Math.log1p(Math.max(max, 1e-6));
  for (let i = 0; i < n; i++) {
    const v = map.values[i];
    if (!Number.isFinite(v) || v <= 0) continue;
    const [r, g, b, a] = heat(Math.log1p(v) / top);
    out[4 * i] = r;
    out[4 * i + 1] = g;
    out[4 * i + 2] = b;
    out[4 * i + 3] = a;
  }
  return out;
}

export const rgbCss = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const heatCss = (t: number) => {
  const [r, g, b] = heat(t);
  return `rgb(${r},${g},${b})`;
};
