// Reactive visualization store for trace display.
// Signals are wired to the solver via tuning-orchestrator.
// Parameter changes trigger solver dispatch; results flow back here.

import { createSignal, createMemo } from 'solid-js';
import type { NpyResult } from './types';

// --- Cell selection ---

const [selectedCell, setSelectedCell] = createSignal<number>(0);

// --- Trace signals ---

const [rawTrace, setRawTrace] = createSignal<Float64Array | null>(null);
const [deconvolvedTrace, setDeconvolvedTrace] =
  createSignal<Float64Array | null>(null);
const [reconvolutionTrace, setReconvolutionTrace] =
  createSignal<Float64Array | null>(null);

// --- Tau parameters (kernel shape) ---

const [tauRise, setTauRise] = createSignal<number>(0.02); // 20ms default
const [tauDecay, setTauDecay] = createSignal<number>(0.4); // 400ms default

// --- Lambda (sparsity penalty) ---

const [lambda, setLambda] = createSignal<number>(0.01); // default sparsity

// --- Solver status ---

export type SolverStatus = 'idle' | 'solving' | 'converged' | 'error';
const [solverStatus, setSolverStatus] = createSignal<SolverStatus>('idle');

// --- Pinned snapshot for before/after comparison ---

const [pinnedDeconvolved, setPinnedDeconvolved] =
  createSignal<Float64Array | null>(null);
const [pinnedReconvolution, setPinnedReconvolution] =
  createSignal<Float64Array | null>(null);
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
  setPinnedDeconvolved(deconv ? new Float64Array(deconv) : null);
  setPinnedReconvolution(reconv ? new Float64Array(reconv) : null);
  setPinnedParams({
    tauRise: tauRise(),
    tauDecay: tauDecay(),
    lambda: lambda(),
  });
}

/** Clear pinned snapshot data. */
function unpinSnapshot(): void {
  setPinnedDeconvolved(null);
  setPinnedReconvolution(null);
  setPinnedParams(null);
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

// --- Load cell traces ---

/**
 * Extract the raw fluorescence trace for a given cell index from the flat
 * typed array. Deconvolved/reconvolution traces are set to null; the
 * tuning orchestrator's reactive effect detects rawTrace changed and
 * triggers a solver dispatch automatically.
 *
 * @param cellIndex - Which cell to extract (row index)
 * @param data - The parsed NpyResult with flat typed array
 * @param shape - Effective [cells, timepoints] after optional swap
 * @param isSwapped - Whether dimensions were swapped by user
 */
function loadCellTraces(
  cellIndex: number,
  data: NpyResult,
  shape: [number, number],
  isSwapped: boolean,
): void {
  const [numCells, numTimepoints] = shape;

  // Guard invalid index
  if (cellIndex < 0 || cellIndex >= numCells) return;

  // Extract raw trace from flat typed array
  const raw = new Float64Array(numTimepoints);

  if (isSwapped) {
    // Original layout was [timepoints, cells], data is row-major
    // After swap: cell i = column i in original = every row's column i
    const origRows = numTimepoints; // original row count = numTimepoints after swap
    for (let t = 0; t < numTimepoints; t++) {
      raw[t] = Number(data.data[t * numCells + cellIndex]);
    }
  } else {
    // Normal layout [cells, timepoints], row-major: cell i = row i
    const offset = cellIndex * numTimepoints;
    for (let t = 0; t < numTimepoints; t++) {
      raw[t] = Number(data.data[offset + t]);
    }
  }

  setRawTrace(raw);
  setSelectedCell(cellIndex);

  // Clear derived traces -- tuning orchestrator will trigger solver dispatch
  setDeconvolvedTrace(null);
  setReconvolutionTrace(null);

  // Clear pinned snapshot to avoid stale cross-cell comparison (Pitfall 4)
  unpinSnapshot();
}

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
  // Solver status
  solverStatus,
  setSolverStatus,
  // Pinned snapshot
  pinnedDeconvolved,
  pinnedReconvolution,
  pinnedParams,
  pinCurrentSnapshot,
  unpinSnapshot,
  // Actions
  loadCellTraces,
};
