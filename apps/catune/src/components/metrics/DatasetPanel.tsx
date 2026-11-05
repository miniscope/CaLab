/**
 * Dataset sidebar tab (first in the right sidebar): how the whole dataset looks (shared measured-SNR histogram,
 * event-height shape, flags) above a per-cell table of the cells being tuned.
 *
 * Everything model-free comes from the dataset overview (computed once for ALL
 * cells, same numbers as CaDecon); the fit columns (R², sparsity) fill in as
 * cells are solved. Display and cell selection only: nothing here feeds the solver.
 *
 * Performance: table metrics are only recomputed while this tab is visible, and
 * only for cells whose solver status just changed to 'fresh'.
 */

import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import {
  OVERVIEW_PARAMS,
  HEIGHT_PROBS,
  FLAG_LABELS,
  flagCounts,
  medianOf,
  isNearNoiseFloor,
  type DatasetOverview,
} from '@calab/core';
import { pickSnrSpread, withoutNonFinite } from '@calab/io';
import { nonFiniteCounts } from '../../lib/data-store.ts';
import { viridisCss } from '@calab/ui/chart';
import { SnrHistogramCard, EventHeightCard, type HeightCurve } from '@calab/ui/dataset';
import '@calab/ui/dataset/dataset.css';
import {
  multiCellResults,
  cellSolverStatuses,
  selectedCells,
  setSelectedCells,
  setSelectionMode,
  displayCount,
} from '../../lib/multi-cell-store.ts';
import { selectedCell, setSelectedCell } from '../../lib/viz-store.ts';
import {
  overview,
  overviewStatus,
  overviewProgress,
  overviewError,
} from '../../lib/overview-store.ts';
import {
  computeCellFitMetrics,
  fitUnavailableReason,
  type CellFitMetrics,
} from '../../lib/fit-metrics.ts';
import { describeSnr } from '../../lib/snr-display.ts';
import { activeSidebarTab } from '../layout/SidebarTabs.tsx';

const MAX_TUNE_CELLS = 20;
const MAX_HIGHLIGHT_CURVES = 16;

// Per-cell fit-metrics cache keyed by cell index.
// Updated incrementally: only recomputed when a cell's status becomes 'fresh'.
const fitCache = new Map<number, CellFitMetrics>();

function DatasetCards(props: { ov: DatasetOverview }) {
  const ov = () => props.ov;
  const snr = createMemo(() => ov().cells.map((c) => c.snr));
  const [brushIds, setBrushIds] = createSignal<number[] | null>(null);

  // Highlight the brushed cells, or (no brush) the cells being tuned, so the
  // histogram shows whether the tuning set spans the SNR range.
  const highlighted = createMemo((): ReadonlySet<number> | null => {
    const b = brushIds();
    if (b) return new Set(b);
    const sel = selectedCells();
    return sel.length > 0 ? new Set(sel) : null;
  });

  const withShape = createMemo(() =>
    ov().cells.filter((c) => c.heightQuantiles.length === HEIGHT_PROBS.length),
  );

  const heightCurves = createMemo((): HeightCurve[] => {
    const out: HeightCurve[] = [];
    const seen = new Set<number>();
    const add = (id: number, kind: HeightCurve['kind']) => {
      const q = ov().cells[id]?.heightQuantiles;
      if (!q || q.length !== HEIGHT_PROBS.length || seen.has(id)) return;
      seen.add(id);
      out.push({ id, quantiles: q, kind });
    };
    // Only a cell that is actually on screen counts as "selected" (the default index 0 may not be).
    if (selectedCells().includes(selectedCell())) add(selectedCell(), 'selected');
    selectedCells()
      .slice(0, MAX_HIGHLIGHT_CURVES)
      .forEach((id) => add(id, 'highlight'));
    return out.reverse(); // selected drawn last so it sits on top
  });

  const counts = createMemo(() => flagCounts(ov()));
  const flagSummary = createMemo(() =>
    counts()
      .byFlag.filter((f) => f.count > 0)
      .map((f) => `${f.count} ${FLAG_LABELS[f.flag].toLowerCase()}`)
      .join(', '),
  );

  const tuneOnBrush = () => {
    const ids = brushIds();
    if (!ids) return;
    const n = Math.min(MAX_TUNE_CELLS, Math.max(1, displayCount()));
    setSelectionMode('manual');
    // Never tune on a cell the solver skips (NaN/Inf samples).
    setSelectedCells(pickSnrSpread(snr(), n, withoutNonFinite(ids, nonFiniteCounts())));
  };

  return (
    <div class="ov-stack dataset-drawer__cards">
      <SnrHistogramCard
        snr={snr}
        noiseFloor={{ value: OVERVIEW_PARAMS.noiseFloorSnr, hi: OVERVIEW_PARAMS.noiseFloorBandHi }}
        silentCount={() => counts().byFlag.find((f) => f.flag === 'silent')?.count ?? 0}
        eventSeparationS={OVERVIEW_PARAMS.eventSeparationS}
        highlighted={highlighted}
        onBrush={setBrushIds}
        brushHint='Without a brush, the bars show the cells you are tuning on. Drag across the bars, then "Tune on these cells" to pick cells spread across that SNR range.'
      />
      <Show when={brushIds()}>
        {(ids) => (
          <div class="dataset-drawer__brush" data-testid="brush-action">
            <span>{ids().length} cells in range</span>
            <button class="btn-secondary btn-small" onClick={tuneOnBrush}>
              Tune on these cells
            </button>
          </div>
        )}
      </Show>
      <EventHeightCard
        probs={HEIGHT_PROBS}
        pooled={() => ov().pooledHeights}
        curves={heightCurves}
        onPick={setSelectedCell}
        nWithShape={() => withShape().length}
        medianEvents={() => medianOf(withShape().map((c) => c.nEvents))}
        eventSeparationS={OVERVIEW_PARAMS.eventSeparationS}
      />
      <p class="dataset-drawer__flags" data-testid="flag-summary">
        <Show when={counts().anyFlag > 0} fallback="No cells flagged.">
          {counts().anyFlag} of {ov().nCells} cells flagged: {flagSummary()}.
        </Show>
      </p>
    </div>
  );
}

export function DatasetPanel() {
  const cellRows = createMemo(() => {
    // Skip computation when the tab is not visible; keep cached rows so the UI doesn't flash empty.
    if (activeSidebarTab() === 'dataset') {
      const results = multiCellResults;
      const statuses = cellSolverStatuses;
      const keys = Object.keys(results).map(Number);
      for (const cached of fitCache.keys()) {
        if (results[cached] === undefined) fitCache.delete(cached);
      }
      for (const cellIndex of keys) {
        const traces = results[cellIndex];
        if (!traces) continue;
        if (!fitCache.has(cellIndex) || statuses[cellIndex] === 'fresh') {
          fitCache.set(cellIndex, computeCellFitMetrics(cellIndex, traces));
        }
      }
    }
    const ov = overview();
    return Array.from(fitCache.values())
      .map((m) => ({
        ...m,
        snr: ov?.cells[m.cellIndex]?.snr ?? NaN,
        rank: ov?.snrRank[m.cellIndex] ?? NaN,
        silent: ov?.cells[m.cellIndex]?.isSilent ?? false,
      }))
      .sort((a, b) => (Number.isNaN(b.snr) ? -1 : b.snr) - (Number.isNaN(a.snr) ? -1 : a.snr));
  });

  const fitOk = createMemo(() => cellRows().filter((r) => r.fit.ok));
  const fitMissing = createMemo(() => cellRows().filter((r) => !r.fit.ok));
  const medianR2 = createMemo(() =>
    medianOf(fitOk().map((r) => (r.fit.ok ? r.fit.rSquared : NaN))),
  );

  return (
    <div class="metrics-panel" data-tutorial="metrics-panel" data-testid="dataset-panel">
      <Switch>
        <Match when={overview()}>{(ov) => <DatasetCards ov={ov()} />}</Match>
        <Match when={overviewStatus() === 'computing'}>
          <div class="metrics-panel__empty">
            Computing dataset overview… {Math.round(overviewProgress() * 100)}%
          </div>
        </Match>
        <Match when={overviewStatus() === 'error'}>
          <div class="metrics-panel__empty">Dataset overview failed: {overviewError()}</div>
        </Match>
      </Switch>

      <div class="metrics-panel__summary">
        <div class="metrics-panel__stat">
          <span class="metrics-panel__stat-label">Median SNR</span>
          <span class="metrics-panel__stat-value">
            {overview() ? overview()!.medianSnr.toFixed(1) : '--'}
          </span>
        </div>
        <div class="metrics-panel__stat">
          <span class="metrics-panel__stat-label">Median R²</span>
          <span class="metrics-panel__stat-value">
            {Number.isFinite(medianR2()) ? medianR2().toFixed(3) : '--'}
          </span>
        </div>
        <div class="metrics-panel__stat">
          <span class="metrics-panel__stat-label">Solved</span>
          <span class="metrics-panel__stat-value">{cellRows().length}</span>
        </div>
      </div>

      <Show
        when={cellRows().length > 0}
        fallback={
          <div class="metrics-panel__empty">
            No cell results yet. Solve cells to see fit metrics.
          </div>
        }
      >
        <div class="metrics-panel__table">
          <div class="metrics-panel__row metrics-panel__row--header">
            <span>Cell</span>
            <span title="Measured SNR (shared with CaDecon), coloured by quantile within the dataset">
              SNR
            </span>
            <span title="R² of the fit against the solver's working trace over the visible window">
              R²
            </span>
            <span>Sparsity</span>
          </div>
          <For each={cellRows()}>
            {(cell) => (
              <div class="metrics-panel__row">
                <span>
                  <span
                    class="metrics-panel__dot"
                    style={{
                      background: Number.isFinite(cell.rank)
                        ? viridisCss(cell.rank)
                        : 'var(--border-default)',
                    }}
                  />
                  {cell.cellIndex + 1}
                </span>
                <span
                  title={
                    Number.isFinite(cell.snr)
                      ? describeSnr({
                          snr: cell.snr,
                          rank: cell.rank,
                          silent: cell.silent,
                          nCells: overview()?.nCells,
                        })
                      : undefined
                  }
                >
                  {Number.isFinite(cell.snr) ? cell.snr.toFixed(1) : '--'}
                  <Show when={Number.isFinite(cell.snr) && isNearNoiseFloor(cell.snr)}>
                    <span class="metrics-panel__noise"> ≈</span>
                  </Show>
                </span>
                <span title={fitUnavailableReason(cell.fit)}>
                  {cell.fit.ok ? cell.fit.rSquared.toFixed(3) : '--'}
                </span>
                <span>{(cell.sparsity * 100).toFixed(0)}%</span>
              </div>
            )}
          </For>
        </div>
        <Show when={fitMissing().length > 0}>
          <p class="metrics-panel__note" data-testid="fit-unavailable">
            R² unavailable for {fitMissing().length} cell{fitMissing().length > 1 ? 's' : ''}:{' '}
            {fitUnavailableReason(fitMissing()[0].fit)}.
          </p>
        </Show>
      </Show>
    </div>
  );
}
