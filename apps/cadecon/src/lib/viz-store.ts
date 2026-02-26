// Visualization state signals for CaDecon chart components.

import { createSignal } from 'solid-js';

// Which iteration to display in charts (null = latest)
const [viewedIteration, setViewedIteration] = createSignal<number | null>(null);

// Which cell to inspect in TraceViewer (null = first available)
const [inspectedCellIndex, setInspectedCellIndex] = createSignal<number | null>(null);

// Series visibility toggles
const [showRawTrace, setShowRawTrace] = createSignal(true);
const [showReconvolved, setShowReconvolved] = createSignal(true);
const [showResidual, setShowResidual] = createSignal(false);
const [showSpikes, setShowSpikes] = createSignal(true);
// Which subset is selected for drill-down (null = none)
const [selectedSubsetIdx, setSelectedSubsetIdx] = createSignal<number | null>(null);

export {
  viewedIteration,
  setViewedIteration,
  inspectedCellIndex,
  setInspectedCellIndex,
  showRawTrace,
  setShowRawTrace,
  showReconvolved,
  setShowReconvolved,
  showResidual,
  setShowResidual,
  showSpikes,
  setShowSpikes,
  selectedSubsetIdx,
  setSelectedSubsetIdx,
};
