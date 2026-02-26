// CaDecon-specific uPlot series configuration builders.
// Trace colors follow the D3 category10 scheme for scientific consistency.

import type uPlot from 'uplot';
import { D3_CATEGORY10, subsetColor, withOpacity } from '@calab/ui/chart';

export { subsetColor, withOpacity };

export function createRawTraceSeries(): uPlot.Series {
  return { label: 'Raw', stroke: '#1f77b4', width: 1 };
}

export function createReconvolvedSeries(): uPlot.Series {
  return { label: 'Reconvolved', stroke: '#ff7f0e', width: 1.5 };
}

export function createResidualSeries(): uPlot.Series {
  return { label: 'Residual', stroke: '#d62728', width: 1 };
}

export function createDeconvolvedSeries(): uPlot.Series {
  return { label: 'Deconvolved', stroke: '#2ca02c', width: 1 };
}

export function createKernelFreeSeries(subsetIdx: number): uPlot.Series {
  const color = D3_CATEGORY10[subsetIdx % D3_CATEGORY10.length];
  return { label: `Subset ${subsetIdx}`, stroke: withOpacity(color, 0.4), width: 1 };
}

export function createKernelFitSeries(): uPlot.Series {
  return { label: 'Fit', stroke: '#9467bd', width: 1.5, dash: [6, 3] };
}

export function createKernelMergedSeries(): uPlot.Series {
  return { label: 'Merged', stroke: '#ff7f0e', width: 2.5 };
}

export function createWeightSeries(): uPlot.Series {
  return {
    label: 'Weight',
    stroke: withOpacity('#17becf', 0.6),
    width: 1,
    fill: withOpacity('#17becf', 0.1),
  };
}

export function createGroundTruthSpikesSeries(): uPlot.Series {
  return { label: 'True Spikes', stroke: 'rgba(255, 193, 7, 0.7)', width: 1.5 };
}

export function createGroundTruthCalciumSeries(): uPlot.Series {
  return { label: 'True Calcium', stroke: 'rgba(0, 188, 212, 0.7)', width: 1.5, dash: [6, 3] };
}
