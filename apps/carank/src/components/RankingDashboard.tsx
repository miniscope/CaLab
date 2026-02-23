import { type JSX, createMemo, For, onMount } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { computePeakSNR, snrToQuality } from '@calab/core';
import { trackEvent } from '@calab/community';
import type { QualityTier } from '@calab/core';
import type { CnmfData } from '../types.ts';

interface RankingDashboardProps {
  data: CnmfData;
}

const TIER_COLORS: Record<QualityTier, string> = {
  good: 'var(--tier-good)',
  fair: 'var(--tier-fair)',
  poor: 'var(--tier-poor)',
};

interface CellMetric {
  index: number;
  snr: number;
  quality: QualityTier;
}

function computeMetrics(data: CnmfData): CellMetric[] {
  const metrics: CellMetric[] = [];
  for (let i = 0; i < data.numCells; i++) {
    const start = i * data.numTimepoints;
    const trace = data.traces.subarray(start, start + data.numTimepoints);
    const snr = computePeakSNR(trace);
    metrics.push({ index: i, snr, quality: snrToQuality(snr) });
  }
  metrics.sort((a, b) => b.snr - a.snr);
  return metrics;
}

export function RankingDashboard(props: RankingDashboardProps): JSX.Element {
  const metrics = createMemo(() => computeMetrics(props.data));

  onMount(() => {
    void trackEvent('ranking_completed', { num_cells: props.data.numCells });
  });

  const tierCounts = createMemo(() => {
    const counts = { good: 0, fair: 0, poor: 0 };
    for (const m of metrics()) {
      counts[m.quality]++;
    }
    return counts;
  });

  return (
    <DashboardPanel id="ranking" variant="data">
      <h2 class="ranking__title">Cell Quality Ranking</h2>

      <div class="ranking__summary">
        <span class="ranking__stat" style={{ color: TIER_COLORS.good }}>
          {tierCounts().good} good
        </span>
        <span class="ranking__stat" style={{ color: TIER_COLORS.fair }}>
          {tierCounts().fair} fair
        </span>
        <span class="ranking__stat" style={{ color: TIER_COLORS.poor }}>
          {tierCounts().poor} poor
        </span>
      </div>

      <table class="ranking__table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Cell</th>
            <th>SNR</th>
            <th>Quality</th>
          </tr>
        </thead>
        <tbody>
          <For each={metrics()}>
            {(m, rank) => (
              <tr>
                <td>{rank() + 1}</td>
                <td>{m.index}</td>
                <td>{m.snr.toFixed(2)}</td>
                <td>
                  <span class="ranking__dot" style={{ background: TIER_COLORS[m.quality] }} />
                  {m.quality}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </DashboardPanel>
  );
}
