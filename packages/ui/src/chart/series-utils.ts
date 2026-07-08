// Shared chart series utilities: color palette, subset coloring, opacity helpers.

/**
 * Okabe-Ito qualitative palette — colorblind-safe under deuteranopia,
 * protanopia, and tritanopia. From Okabe & Ito (2008); popularized for
 * scientific figures by Wong, "Points of view: Color blindness",
 * Nature Methods 8:441 (2011). This is CaLab's single source of chart color;
 * every series/metric color below is drawn from it so no red/green pair is
 * ever used to distinguish two co-plotted series.
 */
export const OKABE_ITO = {
  black: '#000000',
  orange: '#e69f00',
  skyBlue: '#56b4e9',
  bluishGreen: '#009e73',
  yellow: '#f0e442',
  blue: '#0072b2',
  vermillion: '#d55e00',
  reddishPurple: '#cc79a7',
} as const;

/**
 * Ordered qualitative cycle for categorical series (e.g. per-subset curves).
 * Most-separable colors first so small subset counts stay maximally distinct.
 */
export const OKABE_ITO_CYCLE = [
  OKABE_ITO.blue,
  OKABE_ITO.orange,
  OKABE_ITO.bluishGreen,
  OKABE_ITO.reddishPurple,
  OKABE_ITO.skyBlue,
  OKABE_ITO.vermillion,
  OKABE_ITO.yellow,
  OKABE_ITO.black,
] as const;

/** Neutral grey for reference lines / de-emphasized series (not a hue). */
export const NEUTRAL = '#757575';

/**
 * Semantic colors for the calcium trace bands, shared by CaDecon and CaTune so
 * "Raw"/"Fit"/etc. mean the same color in both apps. None of these five collide
 * as a red/green pair.
 */
export const TRACE_COLORS = {
  raw: OKABE_ITO.blue,
  filtered: OKABE_ITO.skyBlue,
  fit: OKABE_ITO.orange,
  deconv: OKABE_ITO.bluishGreen,
  resid: OKABE_ITO.vermillion,
} as const;

/**
 * Ground-truth overlays — distinct from every hue they co-plot with. Calcium is
 * reddish-purple (vs the trace bands); the GT kernel is black (vs the blue/
 * reddish-purple/orange kernel-fit components in KernelDisplay).
 */
export const GROUND_TRUTH_COLORS = {
  calcium: OKABE_ITO.reddishPurple,
  spikes: OKABE_ITO.black,
  kernel: OKABE_ITO.black,
} as const;

/** Bi-exponential kernel-fit components (KernelDisplay). */
export const KERNEL_FIT_COLORS = {
  full: OKABE_ITO.blue,
  slow: OKABE_ITO.reddishPurple,
  fast: OKABE_ITO.orange,
  merged: OKABE_ITO.orange,
} as const;

/**
 * Convergence / asymptote metric colors. The asymptote dashboard uses
 * tPeak/fwhm/r2/pve/stability; the detailed kernel-convergence chart adds the
 * raw taus and their fast-component variants. Chosen so no chart pairs a red
 * with a green.
 */
export const METRIC_COLORS = {
  tPeak: OKABE_ITO.blue,
  fwhm: OKABE_ITO.orange,
  r2: OKABE_ITO.bluishGreen,
  pve: OKABE_ITO.skyBlue,
  stability: OKABE_ITO.reddishPurple,
  tauRise: OKABE_ITO.bluishGreen,
  tauDecay: OKABE_ITO.skyBlue,
  tauRiseFast: OKABE_ITO.reddishPurple,
  tauDecayFast: OKABE_ITO.vermillion,
  residual: NEUTRAL,
} as const;

/** Distribution histograms (Distributions tab). */
export const DISTRIBUTION_COLORS = {
  alpha: OKABE_ITO.blue,
  pve: OKABE_ITO.bluishGreen,
  eventRate: OKABE_ITO.orange,
} as const;

/**
 * D3 category10 — retained as a named general-purpose palette. NOT used for
 * CaLab chart series (it contains a red/green pair that is unsafe for
 * colorblind viewers); prefer OKABE_ITO_CYCLE / subsetColor.
 */
export const D3_CATEGORY10 = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
];

/** Return the colorblind-safe subset color for a given index (wraps around). */
export function subsetColor(idx: number): string {
  return OKABE_ITO_CYCLE[idx % OKABE_ITO_CYCLE.length];
}

/**
 * Convert a color to rgba with the specified opacity.
 * Handles #rrggbb and #rgb hex formats. Returns input unchanged for other formats.
 */
export function withOpacity(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    let hex = color.slice(1);

    // Expand shorthand #rgb to #rrggbb
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((char) => char + char)
        .join('');
    }

    // Parse #rrggbb format
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  // Safe fallback: return unchanged for other formats
  return color;
}
