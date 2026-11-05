// CaDecon-specific uPlot series configuration builders.
// Colors come from the shared colorblind-safe Okabe-Ito palette (@calab/ui/chart).

import type uPlot from 'uplot';
import { KERNEL_FIT_COLORS } from '@calab/ui/chart';

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

export function createKernelFitSlowSeries(): uPlot.Series {
  return { label: 'Slow', stroke: KERNEL_FIT_COLORS.slow, width: 1.5, dash: [6, 3] };
}

export function createKernelFitFastSeries(): uPlot.Series {
  return { label: 'Fast', stroke: KERNEL_FIT_COLORS.fast, width: 1, dash: [3, 2] };
}

export function createKernelFitFullSeries(): uPlot.Series {
  return { label: 'Slow+Fast', stroke: KERNEL_FIT_COLORS.full, width: 2 };
}
