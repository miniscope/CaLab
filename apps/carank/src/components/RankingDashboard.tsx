import type { JSX } from 'solid-js';
import { createMemo } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { computePeakSNR, snrToQuality } from '@calab/core';
import type { QualityTier } from '@calab/core';
import type { CnmfData } from '../types.ts';

interface RankingDashboardProps {
  data: CnmfData;
}

const TIER_COLORS: Record<QualityTier, string> = {
  good: '#2e7d32',
  fair: '#e09800',
  poor: '#d32f2f',
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
  const good = () => metrics().filter((m) => m.quality === 'good').length;
  const fair = () => metrics().filter((m) => m.quality === 'fair').length;
  const poor = () => metrics().filter((m) => m.quality === 'poor').length;

  return (
    <DashboardPanel id="ranking" variant="data">
      <h2 class="ranking__title">Cell Quality Ranking</h2>

      <div class="ranking__summary">
        <span class="ranking__stat" style={{ color: TIER_COLORS.good }}>
          {good()} good
        </span>
        <span class="ranking__stat" style={{ color: TIER_COLORS.fair }}>
          {fair()} fair
        </span>
        <span class="ranking__stat" style={{ color: TIER_COLORS.poor }}>
          {poor()} poor
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
          {metrics().map((m, rank) => (
            <tr>
              <td>{rank + 1}</td>
              <td>{m.index}</td>
              <td>{m.snr.toFixed(2)}</td>
              <td>
                <span class="ranking__dot" style={{ background: TIER_COLORS[m.quality] }} />
                {m.quality}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DashboardPanel>
  );
}
