/**
 * Threshold Trends chart: shows per-cell×subset threshold values evolving over iterations.
 */

import type { JSX } from 'solid-js';
import { PerCellTrendsChart } from './PerCellTrendsChart.tsx';

export function ThresholdTrends(): JSX.Element {
  return (
    <PerCellTrendsChart
      accessor={(entry) => entry.threshold}
      yLabel="Threshold"
      medianLabel="Median Threshold"
      medianColor="#ff7f0e"
      emptyMessage="Run deconvolution to see threshold trends."
    />
  );
}
