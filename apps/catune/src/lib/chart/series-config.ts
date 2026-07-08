// CaTune-specific uPlot series configuration builders for trace panels.
// Colors come from the shared colorblind-safe Okabe-Ito palette (@calab/ui/chart),
// so "Raw"/"Fit"/etc. match CaDecon.

import type uPlot from 'uplot';
import { TRACE_COLORS, GROUND_TRUTH_COLORS, withOpacity } from '@calab/ui/chart';

export function createRawSeries(): uPlot.Series {
  return { label: 'Raw', stroke: TRACE_COLORS.raw, width: 1 };
}

export function createFilteredSeries(): uPlot.Series {
  return { label: 'Filtered', stroke: TRACE_COLORS.filtered, width: 1.5 };
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

export function createGroundTruthSpikesSeries(): uPlot.Series {
  return { label: 'True Spikes', stroke: withOpacity(GROUND_TRUTH_COLORS.spikes, 0.7), width: 1.5 };
}

export function createGroundTruthCalciumSeries(): uPlot.Series {
  return {
    label: 'True Calcium',
    stroke: withOpacity(GROUND_TRUTH_COLORS.calcium, 0.75),
    width: 1.5,
    dash: [6, 3],
  };
}

export function createGroundTruthKernelSeries(): uPlot.Series {
  return {
    label: 'True Kernel',
    stroke: withOpacity(GROUND_TRUTH_COLORS.kernel, 0.8),
    width: 1.5,
    dash: [6, 3],
  };
}

export function createPinnedOverlaySeries(
  label: string,
  baseStroke: string,
  baseWidth: number,
): uPlot.Series {
  const stroke = withOpacity(baseStroke, 0.65);
  return { label, stroke, width: baseWidth + 0.5, dash: [8, 4] };
}
