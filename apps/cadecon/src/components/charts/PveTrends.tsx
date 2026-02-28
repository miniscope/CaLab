/**
 * PVE Trends chart: shows per-cell percent variance explained evolving over iterations.
 */

import type { JSX } from 'solid-js';
import { PerCellTrendsChart } from './PerCellTrendsChart.tsx';

export function PveTrends(): JSX.Element {
  return (
    <PerCellTrendsChart
      accessor={(entry) => entry.pve}
      yLabel="PVE"
      medianLabel="Median PVE"
      medianColor="#2ca02c"
      emptyMessage="Run deconvolution to see PVE trends."
    />
  );
}
