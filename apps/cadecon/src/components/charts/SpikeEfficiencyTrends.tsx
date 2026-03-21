/**
 * Spike Efficiency Trends chart: PVE / N_spikes.
 *
 * Per-cell quality metric measuring how much of the input data each spike
 * accounts for on average. Higher values mean fewer, more meaningful spikes.
 * The kernel's influence is already captured in PVE (which is computed from
 * the full convolution model y ≈ α·(K*s) + b).
 */

import type { JSX } from 'solid-js';
import { PerCellTrendsChart } from './PerCellTrendsChart.tsx';

export function SpikeEfficiencyTrends(): JSX.Element {
  return (
    <PerCellTrendsChart
      accessor={(entry) => {
        const n = entry.sCounts.length;
        if (n === 0) return 0;
        let nSpikes = 0;
        for (let i = 0; i < n; i++) {
          if (entry.sCounts[i] > 0) nSpikes++;
        }
        if (nSpikes === 0) return 0;
        return entry.pve / nSpikes;
      }}
      yLabel="Spike Efficiency"
      medianLabel="Median Spike Efficiency"
      medianColor="#9467bd"
      emptyMessage="Run deconvolution to see spike efficiency trends."
    />
  );
}
