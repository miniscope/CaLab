// Reactive visualization store for trace display.
// Signals are wired to the solver via tuning-orchestrator.
// Parameter changes trigger solver dispatch; results flow back here.

import { createSignal, createMemo } from 'solid-js';
import type { SolverStatus } from './solver-types';
export type { SolverStatus } from './solver-types';
import { pinMultiCellResults, unpinMultiCellResults } from './multi-cell-store';

// --- Cell selection ---

const [selectedCell, setSelectedCell] = createSignal<number>(0);

// --- Trace signals ---

const [rawTrace, setRawTrace] = createSignal<Float64Array | null>(null);
const [deconvolvedTrace, setDeconvolvedTrace] =
  createSignal<Float32Array | null>(null);
const [reconvolutionTrace, setReconvolutionTrace] =
  createSignal<Float32Array | null>(null);

// --- Tau parameters (kernel shape) ---

const [tauRise, setTauRise] = createSignal<number>(0.001); // start at minimum
const [tauDecay, setTauDecay] = createSignal<number>(3.0); // start at maximum (longer than any indicator)

// --- Lambda (sparsity penalty) ---

const [lambda, setLambda] = createSignal<number>(0); // start at minimum sparsity

// --- Filter toggle ---

const [filterEnabled, setFilterEnabled] = createSignal<boolean>(false);

// --- Solver status ---

const [solverStatus, setSolverStatus] = createSignal<SolverStatus>('idle');

// --- Pinned snapshot for before/after comparison ---

const [pinnedDeconvolved, setPinnedDeconvolved] =
  createSignal<Float32Array | null>(null);
const [pinnedReconvolution, setPinnedReconvolution] =
  createSignal<Float32Array | null>(null);
const [pinnedParams, setPinnedParams] = createSignal<{
  tauRise: number;
  tauDecay: number;
  lambda: number;
} | null>(null);

/** Pin the current solver results as a dimmed overlay for before/after comparison. */
function pinCurrentSnapshot(): void {
  const deconv = deconvolvedTrace();
  const reconv = reconvolutionTrace();

  // Deep copy to avoid sharing ArrayBuffer references
  setPinnedDeconvolved(deconv ? new Float32Array(deconv) : null);
  setPinnedReconvolution(reconv ? new Float32Array(reconv) : null);
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
  setPinnedDeconvolved(null);
  setPinnedReconvolution(null);
  setPinnedParams(null);
  unpinMultiCellResults();
}

// --- Derived: residual trace ---

const residualTrace = createMemo<Float64Array | null>(() => {
  const raw = rawTrace();
  const reconv = reconvolutionTrace();
  if (!raw || !reconv || raw.length !== reconv.length) return null;

  const residual = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    residual[i] = raw[i] - reconv[i];
  }
  return residual;
});

// --- Exports ---

export {
  // Cell selection
  selectedCell,
  setSelectedCell,
  // Trace signals
  rawTrace,
  setRawTrace,
  deconvolvedTrace,
  setDeconvolvedTrace,
  reconvolutionTrace,
  setReconvolutionTrace,
  // Derived
  residualTrace,
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
  // Solver status
  solverStatus,
  setSolverStatus,
  // Pinned snapshot
  pinnedDeconvolved,
  pinnedReconvolution,
  pinnedParams,
  pinCurrentSnapshot,
  unpinSnapshot,
};
