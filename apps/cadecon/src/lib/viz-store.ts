// Visualization state signals for CaDecon chart components.

import { createSignal } from 'solid-js';

// Which iteration to display in charts (null = latest)
const [viewedIteration, setViewedIteration] = createSignal<number | null>(null);

// Which cell to inspect in TraceInspector (null = first available)
const [inspectedCellIndex, setInspectedCellIndex] = createSignal<number | null>(null);

// Series visibility toggles (aligned with CaTune naming)
const [showRaw, setShowRaw] = createSignal(true);
const [showFiltered, setShowFiltered] = createSignal(false);
const [showFit, setShowFit] = createSignal(true);
const [showDeconv, setShowDeconv] = createSignal(true);
const [showResidual, setShowResidual] = createSignal(false);

// Which subset is selected for drill-down (null = none)
const [selectedSubsetIdx, setSelectedSubsetIdx] = createSignal<number | null>(null);

// Backward-compatible aliases
const showRawTrace = showRaw;
const setShowRawTrace = setShowRaw;
const showReconvolved = showFit;
const setShowReconvolved = setShowFit;

export {
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
  selectedSubsetIdx,
  setSelectedSubsetIdx,
  // Backward-compatible aliases
  showRawTrace,
  setShowRawTrace,
  showReconvolved,
  setShowReconvolved,
};
