// Visualization state signals for CaDecon chart components.

import { createSignal } from 'solid-js';

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
  showGTCalcium,
  setShowGTCalcium,
  showGTSpikes,
  setShowGTSpikes,
};
