// Reactive visualization store for trace display.
// Signals are wired to the solver via tuning-orchestrator.
// Parameter changes trigger solver dispatch; results flow back here.

import { createSignal } from 'solid-js';
import type { SolverStatus } from './solver-types.ts';
export type { SolverStatus } from './solver-types.ts';
import { pinMultiCellResults, unpinMultiCellResults } from './multi-cell-store.ts';

// --- Cell selection ---

const [selectedCell, setSelectedCell] = createSignal<number>(0);

// --- Tau parameters (kernel shape) ---

const [tauRise, setTauRise] = createSignal<number>(0.001); // start at minimum
const [tauDecay, setTauDecay] = createSignal<number>(3.0); // start at maximum (longer than any indicator)

// --- Lambda (sparsity penalty) ---

const [lambda, setLambda] = createSignal<number>(0); // start at minimum sparsity

// --- Filter toggle ---

const [filterEnabled, setFilterEnabled] = createSignal<boolean>(false);

// --- Trace visibility toggles (legend click-to-hide) ---

const [showRaw, setShowRaw] = createSignal<boolean>(true);
const [showFiltered, setShowFiltered] = createSignal<boolean>(true);
const [showFit, setShowFit] = createSignal<boolean>(true);
const [showDeconv, setShowDeconv] = createSignal<boolean>(true);
const [showResid, setShowResid] = createSignal<boolean>(true);
const [showGTCalcium, setShowGTCalcium] = createSignal<boolean>(true);
const [showGTSpikes, setShowGTSpikes] = createSignal<boolean>(true);

// --- Card height (shared across all cell cards) ---

const [cardHeight, setCardHeight] = createSignal<number>(280);

// --- Solver status ---

const [solverStatus] = createSignal<SolverStatus>('idle');

// --- Pinned snapshot for before/after comparison ---

const [pinnedParams, setPinnedParams] = createSignal<{
  tauRise: number;
  tauDecay: number;
  lambda: number;
} | null>(null);

/** Pin the current solver results as a dimmed overlay for before/after comparison. */
function pinCurrentSnapshot(): void {
  setPinnedParams({
    tauRise: tauRise(),
    tauDecay: tauDecay(),
    lambda: lambda(),
  });

  // Also snapshot all multi-cell results for card grid overlays
  pinMultiCellResults();
}

/** Clear pinned snapshot data. */
function unpinSnapshot(): void {
  setPinnedParams(null);
  unpinMultiCellResults();
}

// --- Exports ---

export {
  // Cell selection
  selectedCell,
  setSelectedCell,
  // Tau parameters
  tauRise,
  setTauRise,
  tauDecay,
  setTauDecay,
  // Lambda (sparsity)
  lambda,
  setLambda,
  // Filter toggle
  filterEnabled,
  setFilterEnabled,
  // Trace visibility toggles
  showRaw, setShowRaw,
  showFiltered, setShowFiltered,
  showFit, setShowFit,
  showDeconv, setShowDeconv,
  showResid, setShowResid,
  showGTCalcium, setShowGTCalcium,
  showGTSpikes, setShowGTSpikes,
  // Card height
  cardHeight, setCardHeight,
  // Solver status
  solverStatus,
  // Pinned snapshot
  pinnedParams,
  pinCurrentSnapshot,
  unpinSnapshot,
};
