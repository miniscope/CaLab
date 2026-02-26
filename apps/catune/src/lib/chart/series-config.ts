// CaTune-specific uPlot series configuration builders for trace panels.
// Trace colors follow the D3 category10 scheme for scientific consistency.

import type uPlot from 'uplot';
import { withOpacity } from '@calab/ui/chart';

export function createRawSeries(): uPlot.Series {
  return { label: 'Raw', stroke: '#1f77b4', width: 1 };
}

export function createFilteredSeries(): uPlot.Series {
  return { label: 'Filtered', stroke: '#17becf', width: 1.5 };
}

export function createFitSeries(): uPlot.Series {
  return { label: 'Fit', stroke: '#ff7f0e', width: 1.5 };
}

export function createDeconvolvedSeries(): uPlot.Series {
  return { label: 'Deconvolved', stroke: '#2ca02c', width: 1 };
}

export function createResidualSeries(): uPlot.Series {
  return { label: 'Residuals', stroke: '#d62728', width: 1 };
}

export function createGroundTruthSpikesSeries(): uPlot.Series {
  return { label: 'True Spikes', stroke: 'rgba(255, 193, 7, 0.7)', width: 1.5 };
}

export function createGroundTruthCalciumSeries(): uPlot.Series {
  return { label: 'True Calcium', stroke: 'rgba(0, 188, 212, 0.7)', width: 1.5, dash: [6, 3] };
}

export function createGroundTruthKernelSeries(): uPlot.Series {
  return { label: 'True Kernel', stroke: 'rgba(233, 30, 99, 0.8)', width: 1.5, dash: [6, 3] };
}

export function createPinnedOverlaySeries(
  label: string,
  baseStroke: string,
  baseWidth: number,
): uPlot.Series {
  const stroke = withOpacity(baseStroke, 0.65);
  return { label, stroke, width: baseWidth + 0.5, dash: [8, 4] };
}
