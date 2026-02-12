/**
 * Aggregate metrics dashboard shown in the sidebar metrics tab.
 * Displays signal quality and solver output metrics across all selected cells.
 */

import { createMemo, For, Show } from 'solid-js';
import { multiCellResults } from '../../lib/multi-cell-store';
import { computePeakSNR, snrToQuality } from '../../lib/metrics/snr';
import { computeSparsityRatio, computeResidualRMS, computeRSquared } from '../../lib/metrics/solver-metrics';

interface CellMetrics {
  cellIndex: number;
  snr: number;
  quality: 'good' | 'fair' | 'poor';
  sparsity: number;
  residualRms: number;
  rSquared: number;
}

export function MetricsPanel() {
  const cellMetrics = createMemo<CellMetrics[]>(() => {
    const results = multiCellResults();
    const metrics: CellMetrics[] = [];

    for (const [cellIndex, traces] of results.entries()) {
      const snr = computePeakSNR(traces.raw);
      metrics.push({
        cellIndex,
        snr,
        quality: snrToQuality(snr),
        sparsity: computeSparsityRatio(traces.deconvolved),
        residualRms: computeResidualRMS(traces.raw, traces.reconvolution),
        rSquared: computeRSquared(traces.raw, traces.reconvolution),
      });
    }

    return metrics.sort((a, b) => b.snr - a.snr);
  });

  const avgSNR = createMemo(() => {
    const m = cellMetrics();
    if (m.length === 0) return 0;
    return m.reduce((sum, c) => sum + c.snr, 0) / m.length;
  });

  const avgRSquared = createMemo(() => {
    const m = cellMetrics();
    if (m.length === 0) return 0;
    return m.reduce((sum, c) => sum + c.rSquared, 0) / m.length;
  });

  const qualityColor = (q: string) => {
    if (q === 'good') return 'var(--success)';
    if (q === 'fair') return 'var(--warning)';
    return 'var(--error)';
  };

  return (
    <div class="metrics-panel">
      <h3 class="metrics-panel__title">Metrics</h3>

      <Show
        when={cellMetrics().length > 0}
        fallback={
          <div class="metrics-panel__empty">
            No cell results yet. Solve cells to see metrics.
          </div>
        }
      >
        {/* Aggregate stats */}
        <div class="metrics-panel__summary">
          <div class="metrics-panel__stat">
            <span class="metrics-panel__stat-label">Avg SNR</span>
            <span class="metrics-panel__stat-value">{avgSNR().toFixed(1)}</span>
          </div>
          <div class="metrics-panel__stat">
            <span class="metrics-panel__stat-label">Avg R²</span>
            <span class="metrics-panel__stat-value">{avgRSquared().toFixed(3)}</span>
          </div>
          <div class="metrics-panel__stat">
            <span class="metrics-panel__stat-label">Cells</span>
            <span class="metrics-panel__stat-value">{cellMetrics().length}</span>
          </div>
        </div>

        {/* Per-cell table */}
        <div class="metrics-panel__table">
          <div class="metrics-panel__row metrics-panel__row--header">
            <span>Cell</span>
            <span>SNR</span>
            <span>R²</span>
            <span>Sparsity</span>
          </div>
          <For each={cellMetrics()}>
            {(cell) => (
              <div class="metrics-panel__row">
                <span>
                  <span
                    class="metrics-panel__dot"
                    style={{ background: qualityColor(cell.quality) }}
                  />
                  {cell.cellIndex + 1}
                </span>
                <span>{cell.snr.toFixed(1)}</span>
                <span>{cell.rSquared.toFixed(3)}</span>
                <span>{(cell.sparsity * 100).toFixed(0)}%</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
