/**
 * Event Rate Trends chart: shows per-cell spike rate (Hz) evolving over iterations.
 *
 * Event rate = sum(sCounts) / (sCounts.length / fs). When sCounts is empty or
 * fs is unavailable the rate is 0.
 */

import { createMemo, type JSX } from 'solid-js';
import { PerCellTrendsChart } from './PerCellTrendsChart.tsx';
import { samplingRate } from '../../lib/data-store.ts';

export function EventRateTrends(): JSX.Element {
  const fs = createMemo(() => samplingRate() ?? 1);

  return (
    <PerCellTrendsChart
      accessor={(entry) => {
        const n = entry.sCounts.length;
        if (n === 0) return 0;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += entry.sCounts[i];
        return sum / (n / fs());
      }}
      yLabel="Hz"
      medianLabel="Median Event Rate"
      medianColor="#ff7f0e"
      emptyMessage="Run deconvolution to see event rate trends."
    />
  );
}
