// CaTune-specific uPlot series configuration builders for trace panels.
// Colors come from the shared colorblind-safe Okabe-Ito palette (@calab/ui/chart),
// so "Raw"/"Fit"/etc. match CaDecon.

import type uPlot from 'uplot';
import { TRACE_COLORS, withOpacity, solverInputLabel } from '@calab/ui/chart';

export function createRawSeries(): uPlot.Series {
  return { label: 'Raw', stroke: TRACE_COLORS.raw, width: 1 };
}

/**
 * The solver's working trace (what Fit/Deconv are computed against): raw minus
 * the rolling-percentile baseline, plus the bandpass when the Noise Filter is on.
 */
export function createFilteredSeries(filterEnabled: boolean): uPlot.Series {
  return { label: solverInputLabel(filterEnabled), stroke: TRACE_COLORS.filtered, width: 1.5 };
}

export function createFitSeries(): uPlot.Series {
  return { label: 'Fit', stroke: TRACE_COLORS.fit, width: 1.5 };
}

export function createDeconvolvedSeries(): uPlot.Series {
  return { label: 'Deconvolved', stroke: TRACE_COLORS.deconv, width: 1 };
}

export function createResidualSeries(): uPlot.Series {
  return { label: 'Residuals', stroke: TRACE_COLORS.resid, width: 1 };
}

export function createPinnedOverlaySeries(
  label: string,
  baseStroke: string,
  baseWidth: number,
): uPlot.Series {
  const stroke = withOpacity(baseStroke, 0.65);
  return { label, stroke, width: baseWidth + 0.5, dash: [8, 4] };
}
