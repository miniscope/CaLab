/**
 * Subset drill-down panel: shows subset-specific kernel, stats, and per-cell browser.
 * Replaces the distribution card row when a subset is selected.
 */

import { createMemo, Show, type JSX } from 'solid-js';
import { convergenceHistory } from '../../lib/iteration-store.ts';
import {
  subsetRectangles,
  selectedSubsetIdx,
  setSelectedSubsetIdx,
} from '../../lib/subset-store.ts';
import { samplingRate } from '../../lib/data-store.ts';
import { SubsetKernelFit } from './SubsetKernelFit.tsx';
import { SubsetStats } from './SubsetStats.tsx';

export function SubsetDrillDown(): JSX.Element {
  const subsetIdx = () => selectedSubsetIdx()!;

  const snapshot = createMemo(() => {
    const history = convergenceHistory();
    return history.length > 0 ? history[history.length - 1] : null;
  });

  const rect = createMemo(() => {
    const rects = subsetRectangles();
    const idx = subsetIdx();
    if (idx >= rects.length) return null;
    return rects[idx];
  });

  const cellRange = createMemo((): [number, number] => {
    const r = rect();
    if (!r) return [0, 0];
    return [r.cellStart, r.cellEnd - 1];
  });

  const timeRange = createMemo((): [number, number] => {
    const r = rect();
    const fs = samplingRate();
    if (!r || !fs) return [0, 0];
    return [+(r.tStart / fs).toFixed(1), +(r.tEnd / fs).toFixed(1)];
  });

  return (
    <div class="subset-drilldown">
      <div class="subset-drilldown__header">
        <strong>Subset K{subsetIdx()} Details</strong>
        <button class="subset-drilldown__close" onClick={() => setSelectedSubsetIdx(null)}>
          Close
        </button>
      </div>

      <Show when={snapshot()}>
        {(snap) => (
          <div class="subset-drilldown__content">
            <SubsetKernelFit subsetIdx={subsetIdx()} snapshot={snap()} />
            <SubsetStats
              subsetIdx={subsetIdx()}
              snapshot={snap()}
              cellRange={cellRange()}
              timeRange={timeRange()}
            />
          </div>
        )}
      </Show>
    </div>
  );
}
