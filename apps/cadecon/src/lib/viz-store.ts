// Visualization state signals for CaDecon chart components.

import { createSignal } from 'solid-js';
import type { CellSortKey } from '@calab/core';

// Which iteration to display in charts (null = latest)
const [viewedIteration, setViewedIteration] = createSignal<number | null>(null);

// Which cell to inspect in TraceInspector (null = first available)
const [inspectedCellIndex, setInspectedCellIndex] = createSignal<number | null>(null);

// Series visibility toggles
const [showRaw, setShowRaw] = createSignal(true);
const [showFiltered, setShowFiltered] = createSignal(true);
const [showFit, setShowFit] = createSignal(true);
const [showDeconv, setShowDeconv] = createSignal(true);
const [showResidual, setShowResidual] = createSignal(false);

// Ground truth series visibility (default true so they show immediately on reveal)
const [showGTCalcium, setShowGTCalcium] = createSignal(true);
const [showGTSpikes, setShowGTSpikes] = createSignal(true);

// Sparsity comparison overlay (display toggle): when on, TraceInspector overlays
// the opposite-noise-constrained deconvolution that was precomputed during the
// run (requires `sparsityCompareEnabled`), so the impact of noise-constrained
// sparsity is visible. Read-only on the browse path — no live solve here.
const [showSparsityCompare, setShowSparsityCompare] = createSignal(true);

// Linked cell highlight shared by the overview cards, the raster, the PVE-vs-SNR
// scatter and the CellSelector. `highlightSource` names what set it (e.g. a
// flag key or 'snr-brush') so the source can show itself as active.
const [highlightedCells, setHighlightedCellsRaw] = createSignal<ReadonlySet<number> | null>(null);
const [highlightSource, setHighlightSource] = createSignal<string | null>(null);

/** Highlight `ids` (null or empty clears) and record which control set it. */
function setHighlightedCells(ids: readonly number[] | null, source: string | null = null): void {
  if (!ids || ids.length === 0) {
    setHighlightedCellsRaw(null);
    setHighlightSource(null);
    return;
  }
  setHighlightedCellsRaw(new Set(ids));
  setHighlightSource(source);
}

// Raster row order (display only).
const [rasterSort, setRasterSort] = createSignal<CellSortKey>('index');

export {
  highlightedCells,
  setHighlightedCells,
  highlightSource,
  rasterSort,
  setRasterSort,
  viewedIteration,
  setViewedIteration,
  inspectedCellIndex,
  setInspectedCellIndex,
  showRaw,
  setShowRaw,
  showFiltered,
  setShowFiltered,
  showFit,
  setShowFit,
  showDeconv,
  setShowDeconv,
  showResidual,
  setShowResidual,
  showGTCalcium,
  setShowGTCalcium,
  showGTSpikes,
  setShowGTSpikes,
  showSparsityCompare,
  setShowSparsityCompare,
};
