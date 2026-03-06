/**
 * Spike Cost Trends chart: (1 + log(totalActivity)) / (PVE * kernelArea).
 *
 * U-shaped metric that should minimize at the correct kernel:
 * - Early (slow kernel): PVE is low → cost is high
 * - Correct kernel: PVE is high, kernel area right-sized, moderate spikes → minimum
 * - Overfit (collapsed kernel): kernel area shrinks, spikes explode → cost rises again
 */

import type { JSX } from 'solid-js';
import { PerCellTrendsChart } from './PerCellTrendsChart.tsx';
import { computeNormalizedKernelArea } from '../../lib/math-utils.ts';

export function SpikeEfficiencyTrends(): JSX.Element {
  return (
    <PerCellTrendsChart
      accessor={(entry, historyEntry) => {
        const n = entry.sCounts.length;
        if (n === 0) return 0;
        let totalActivity = 0;
        for (let i = 0; i < n; i++) totalActivity += entry.sCounts[i];
        if (totalActivity < 1e-12) return 0;
        const kernelArea = computeNormalizedKernelArea(historyEntry.tauRise, historyEntry.tauDecay);
        const denom = entry.pve * kernelArea;
        if (denom < 1e-12) return 0;
        return (1 + Math.log(totalActivity)) / denom;
      }}
      yLabel="Spike Cost"
      medianLabel="Median Spike Cost"
      medianColor="#9467bd"
      emptyMessage="Run deconvolution to see spike cost trends."
    />
  );
}
