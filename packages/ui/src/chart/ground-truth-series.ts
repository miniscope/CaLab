// uPlot series for simulated ground truth (true spikes, calcium and kernel),
// shared by CaTune and CaDecon so the overlays look the same in both apps.

import type uPlot from 'uplot';
import { GROUND_TRUTH_COLORS, withOpacity } from './series-utils.ts';

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
