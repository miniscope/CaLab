/**
 * Aggregate metrics dashboard shown in the sidebar metrics tab.
 * Displays signal quality and solver output metrics across all selected cells.
 *
 * Performance: metrics are only recomputed when the metrics tab is visible,
 * and only for cells whose solver status just changed to 'fresh'.
 * Per-cell metrics are cached and reused across renders.
 */

import { createMemo, For, Show } from 'solid-js';
import { multiCellResults, cellSolverStatuses } from '../../lib/multi-cell-store.ts';
import { computePeakSNR, snrToQuality } from '../../lib/metrics/snr.ts';
import {
  computeSparsityRatio,
  computeResidualRMS,
  computeRSquared,
} from '../../lib/metrics/solver-metrics.ts';
import { activeSidebarTab } from '../layout/SidebarTabs.tsx';

interface CellMetrics {
  cellIndex: number;
  snr: number;
  quality: 'good' | 'fair' | 'poor';
  sparsity: number;
  residualRms: number;
  rSquared: number;
}

// Per-cell metrics cache keyed by cell index.
// Updated incrementally: only recomputed when a cell's status becomes 'fresh'.
const metricsCache = new Map<number, CellMetrics>();

function computeMetricsForCell(
  cellIndex: number,
  traces: {
    raw: Float64Array;
    deconvolved: Float32Array | Float64Array;
    reconvolution: Float32Array | Float64Array;
  },
): CellMetrics {
  const snr = computePeakSNR(traces.raw);
  return {
    cellIndex,
    snr,
    quality: snrToQuality(snr),
    sparsity: computeSparsityRatio(traces.deconvolved),
    residualRms: computeResidualRMS(traces.raw, traces.reconvolution),
    rSquared: computeRSquared(traces.raw, traces.reconvolution),
  };
}

export function MetricsPanel() {
  const cellMetrics = createMemo<CellMetrics[]>(() => {
    // Skip computation when metrics tab is not visible
    if (activeSidebarTab() !== 'metrics') {
      // Return cached values so the UI doesn't flash empty on tab switch
      const cached = Array.from(metricsCache.values());
      return cached.length > 0 ? cached.sort((a, b) => b.snr - a.snr) : [];
    }

    const results = multiCellResults;
    const statuses = cellSolverStatuses;
    const resultKeys = Object.keys(results).map(Number);

    // Remove cached entries for cells no longer in results
    for (const cachedIndex of metricsCache.keys()) {
      if (results[cachedIndex] === undefined) {
        metricsCache.delete(cachedIndex);
      }
    }

    // Update only cells that are 'fresh' or not yet cached
    for (const cellIndex of resultKeys) {
      const traces = results[cellIndex];
      if (!traces) continue;
      const status = statuses[cellIndex];
      const hasCached = metricsCache.has(cellIndex);

      if (!hasCached || status === 'fresh') {
        metricsCache.set(cellIndex, computeMetricsForCell(cellIndex, traces));
      }
    }

    return Array.from(metricsCache.values()).sort((a, b) => b.snr - a.snr);
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
    <div class="metrics-panel" data-tutorial="metrics-panel">
      <h3 class="metrics-panel__title">Metrics</h3>

      <Show
        when={cellMetrics().length > 0}
        fallback={
          <div class="metrics-panel__empty">No cell results yet. Solve cells to see metrics.</div>
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
