/**
 * Band layout and residual math shared by the CaTune and CaDecon trace charts.
 *
 * Both charts stack three bands on one y-axis: the raw/fit traces on top, the
 * deconvolved activity in a band below, and the residual (signal - fit) in a
 * band below that. These helpers place values into those bands.
 */

import { downsampleMinMax } from './downsample.ts';

export interface BandLayout {
  deconvTop: number;
  deconvBottom: number;
  deconvHeight: number;
  residTop: number;
  residBottom: number;
  residHeight: number;
}

export interface BandSpacing {
  /** Distance from the raw-trace minimum down to the top of the deconv band (y units). */
  deconvGap: number;
  /** Deconv band height as a fraction of the raw-trace range. */
  deconvScale: number;
  /** Distance from the bottom of the deconv band down to the top of the residual band (y units). */
  residGap: number;
  /** Residual band height as a fraction of the raw-trace range. */
  residScale: number;
}

/** Compute the y positions of the deconv and residual bands below a trace spanning [rawMin, rawMax]. */
export function computeBandLayout(
  rawMin: number,
  rawMax: number,
  spacing: BandSpacing,
): BandLayout {
  const rawRange = rawMax - rawMin;
  const deconvHeight = rawRange * spacing.deconvScale;
  const deconvTop = rawMin - spacing.deconvGap;
  const deconvBottom = deconvTop - deconvHeight;
  const residHeight = rawRange * spacing.residScale;
  const residTop = deconvBottom - spacing.residGap;
  const residBottom = residTop - residHeight;
  return { deconvTop, deconvBottom, deconvHeight, residTop, residBottom, residHeight };
}

/**
 * Linearly map values from [srcMin, srcMax] onto [bandBottom, bandBottom + bandHeight].
 * `null` entries (gaps) stay `null`. With `clampTop`, values above srcMax are
 * drawn at the top of the band.
 */
export function scaleToBand(
  values: readonly (number | null)[],
  srcMin: number,
  srcMax: number,
  bandBottom: number,
  bandHeight: number,
  options: { clampTop?: boolean } = {},
): (number | null)[] {
  const range = srcMax - srcMin || 1;
  return values.map((v) => {
    if (v === null) return null;
    let norm = (v - srcMin) / range;
    if (options.clampTop && norm > 1) norm = 1;
    return bandBottom + norm * bandHeight;
  });
}

/**
 * Build the downsampled residual series (signal - fit) mapped into the residual band.
 *
 * The residual is computed sample-by-sample at FULL resolution and only then
 * min/max-downsampled. Subtracting two independently downsampled series is
 * wrong: each bucket emits (min, max) in its own series' time order, so the
 * i-th points of signal and fit can be different samples.
 *
 * The residual is min/max normalized into the band, so any positive affine
 * normalization applied identically to both inputs (e.g. z-scoring) does not
 * change the result and can be skipped by callers.
 *
 * @param x - Time axis, same length as signal and fit
 * @param signal - Trace that was fit (raw or filtered)
 * @param fit - Reconvolved fit, or null when there is none
 * @param targetBuckets - Bucket count passed to downsampleMinMax
 * @param bandBottom - Bottom of the residual band
 * @param bandHeight - Height of the residual band
 * @param fitStartIndex - Samples before this index are excluded (e.g. the solver's warm-up transient)
 * @returns Series aligned with downsampleMinMax(x, ..., targetBuckets); all `null` when no residual exists
 */
export function residualBandSeries(
  x: ArrayLike<number>,
  signal: ArrayLike<number>,
  fit: ArrayLike<number> | null,
  targetBuckets: number,
  bandBottom: number,
  bandHeight: number,
  fitStartIndex = 0,
): (number | null)[] {
  const len = x.length;
  const resid = new Float64Array(len).fill(NaN);
  let rMin = Infinity;
  let rMax = -Infinity;
  if (fit) {
    const n = Math.min(len, signal.length, fit.length);
    for (let i = Math.max(0, fitStartIndex); i < n; i++) {
      const r = signal[i] - fit[i];
      if (!Number.isFinite(r)) continue;
      resid[i] = r;
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
    }
  }
  const [, dsResid] = downsampleMinMax(x, resid, targetBuckets);
  return scaleToBand(dsResid, rMin, rMax, bandBottom, bandHeight);
}
