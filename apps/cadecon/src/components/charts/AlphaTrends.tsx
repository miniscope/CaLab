/**
 * Alpha Trends chart: shows per-cell×subset alpha values evolving over iterations.
 */

import type { JSX } from 'solid-js';
import { PerCellTrendsChart } from './PerCellTrendsChart.tsx';

export function AlphaTrends(): JSX.Element {
  return (
    <PerCellTrendsChart
      accessor={(entry) => entry.alpha}
      yLabel="Alpha"
      medianLabel="Median Alpha"
      medianColor="#1f77b4"
      emptyMessage="Run deconvolution to see alpha trends."
    />
  );
}
