/**
 * Dataset tab: the model-free overview of the imported data (SNR, event-height
 * shape, baseline over time, quality flags). Display only: nothing here feeds
 * the solver. Brushing a card or clicking a flag highlights rows in the raster;
 * clicking a cell id or a curve inspects that cell.
 */

import { createMemo, Match, Switch, type JSX } from 'solid-js';
import {
  OVERVIEW_PARAMS,
  HEIGHT_PROBS,
  FLAG_ORDER,
  FLAG_LABELS,
  FLAG_DESCRIPTIONS,
  cellsWithFlag,
  flagCounts,
  type DatasetOverview,
} from '@calab/core';
import {
  SnrHistogramCard,
  EventHeightCard,
  BaselineCard,
  QualityFlagList,
  type HeightCurve,
  type FlagItem,
} from '@calab/ui/dataset';
import '@calab/ui/dataset/dataset.css';
import {
  overview,
  overviewStatus,
  overviewProgress,
  overviewError,
} from '../../lib/overview-store.ts';
import {
  highlightedCells,
  setHighlightedCells,
  highlightSource,
  inspectedCellIndex,
  setInspectedCellIndex,
} from '../../lib/viz-store.ts';

const MAX_FLAG_CURVES = 24;

function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const MAX_HIGHLIGHT_CURVES = 16;

function DatasetCards(props: { ov: DatasetOverview }): JSX.Element {
  const ov = () => props.ov;
  const snr = createMemo(() => ov().cells.map((c) => c.snr));
  const nu = createMemo(() => {
    const vals = ov().cells.map((c) => c.nu);
    return vals.some((v) => v != null) ? vals : null;
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
    const sel = inspectedCellIndex();
    if (sel != null) add(sel, 'selected');
    cellsWithFlag(ov(), 'outlier-height')
      .slice(0, MAX_FLAG_CURVES)
      .forEach((id) => add(id, 'flag'));
    [...(highlightedCells() ?? [])]
      .slice(0, MAX_HIGHLIGHT_CURVES)
      .forEach((id) => add(id, 'highlight'));
    // Selected drawn last so it sits on top.
    return out.reverse();
  });

  const flagItems = createMemo((): FlagItem[] =>
    FLAG_ORDER.map((flag) => ({
      key: flag,
      label: FLAG_LABELS[flag],
      description: FLAG_DESCRIPTIONS[flag],
      ids: cellsWithFlag(ov(), flag),
    })),
  );
  const counts = createMemo(() => flagCounts(ov()));

  return (
    <div class="dataset-grid">
      <SnrHistogramCard
        snr={snr}
        nu={nu}
        noiseFloor={{ value: OVERVIEW_PARAMS.noiseFloorSnr, hi: OVERVIEW_PARAMS.noiseFloorBandHi }}
        silentCount={() => counts().byFlag.find((f) => f.flag === 'silent')?.count ?? 0}
        eventSeparationS={OVERVIEW_PARAMS.eventSeparationS}
        highlighted={highlightedCells}
        selected={inspectedCellIndex}
        onBrush={(ids) => setHighlightedCells(ids, 'snr')}
      />
      <EventHeightCard
        probs={HEIGHT_PROBS}
        pooled={() => ov().pooledHeights}
        curves={heightCurves}
        onPick={setInspectedCellIndex}
        nWithShape={() => withShape().length}
        medianEvents={() => medianOf(withShape().map((c) => c.nEvents))}
        eventSeparationS={OVERVIEW_PARAMS.eventSeparationS}
      />
      <BaselineCard
        data={() => ov().baseline}
        highlighted={highlightedCells}
        onBrush={(ids) => setHighlightedCells(ids, 'baseline')}
      />
      <QualityFlagList
        items={flagItems}
        activeKey={highlightSource}
        onSelect={(key, ids) => setHighlightedCells(key ? ids : null, key)}
        onPick={setInspectedCellIndex}
        totalCells={() => ov().nCells}
        flaggedCells={() => counts().anyFlag}
        help={
          <>
            <p>Model-free checks on the raw traces; nothing here changes the solver.</p>
            <p>
              Outliers use the modified z-score (|z| &gt; {OVERVIEW_PARAMS.outlierZ}, Iglewicz &amp;
              Hoaglin) across this dataset's cells. Click a row to highlight its cells in the
              raster; click an id to inspect that cell.
            </p>
          </>
        }
      />
    </div>
  );
}

export function DatasetPanel(): JSX.Element {
  return (
    <Switch>
      <Match when={overview()}>{(ov) => <DatasetCards ov={ov()} />}</Match>
      <Match when={overviewStatus() === 'computing'}>
        <div class="kernel-chart-wrapper kernel-chart-wrapper--empty">
          Computing dataset overview… {Math.round(overviewProgress() * 100)}%
        </div>
      </Match>
      <Match when={overviewStatus() === 'error'}>
        <div class="kernel-chart-wrapper kernel-chart-wrapper--empty">
          Dataset overview failed: {overviewError()}
        </div>
      </Match>
    </Switch>
  );
}
