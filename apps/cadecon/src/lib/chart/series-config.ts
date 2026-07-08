// CaDecon-specific uPlot series configuration builders.
// Colors come from the shared colorblind-safe Okabe-Ito palette (@calab/ui/chart).

import type uPlot from 'uplot';
import {
  TRACE_COLORS,
  GROUND_TRUTH_COLORS,
  KERNEL_FIT_COLORS,
  OKABE_ITO,
  subsetColor,
  withOpacity,
} from '@calab/ui/chart';

export { subsetColor, withOpacity };

/** Divide every element by the array's peak value so the max becomes 1.0. */
export function peakNormalize(arr: number[] | Float32Array): void {
  let peak = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > peak) peak = arr[i];
  }
  if (peak > 1e-10) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] /= peak;
    }
  }
}

export function createRawTraceSeries(): uPlot.Series {
  return { label: 'Raw', stroke: TRACE_COLORS.raw, width: 1 };
}

export function createReconvolvedSeries(): uPlot.Series {
  return { label: 'Reconvolved', stroke: TRACE_COLORS.fit, width: 1.5 };
}

export function createResidualSeries(): uPlot.Series {
  return { label: 'Residual', stroke: TRACE_COLORS.resid, width: 1 };
}

export function createDeconvolvedSeries(): uPlot.Series {
  return { label: 'Deconvolved', stroke: TRACE_COLORS.deconv, width: 1 };
}

export function createKernelFreeSeries(subsetIdx: number): uPlot.Series {
  return {
    label: `Subset ${subsetIdx}`,
    stroke: withOpacity(subsetColor(subsetIdx), 0.4),
    width: 1,
  };
}

export function createKernelFitSlowSeries(): uPlot.Series {
  return { label: 'Slow', stroke: KERNEL_FIT_COLORS.slow, width: 1.5, dash: [6, 3] };
}

export function createKernelFitFastSeries(): uPlot.Series {
  return { label: 'Fast', stroke: KERNEL_FIT_COLORS.fast, width: 1, dash: [3, 2] };
}

export function createKernelFitFullSeries(): uPlot.Series {
  return { label: 'Slow+Fast', stroke: KERNEL_FIT_COLORS.full, width: 2 };
}

export function createKernelMergedSeries(): uPlot.Series {
  return { label: 'Merged', stroke: KERNEL_FIT_COLORS.merged, width: 2.5 };
}

export function createWeightSeries(): uPlot.Series {
  return {
    label: 'Weight',
    stroke: withOpacity(OKABE_ITO.skyBlue, 0.6),
    width: 1,
    fill: withOpacity(OKABE_ITO.skyBlue, 0.1),
  };
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
