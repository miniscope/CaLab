// Cell Solve Manager: reactive orchestrator for parallel windowed solving.
// Watches selectedCells + global params, dispatches per-cell jobs through the worker pool.
// Replaces multi-cell-solver.ts, tuning-orchestrator.ts, and job-scheduler.ts.

import { createEffect, on, onCleanup } from 'solid-js';
import { tauRise, tauDecay, lambda, selectedCell } from './viz-store';
import { parsedData, effectiveShape, swapped, samplingRate } from './data-store';
import {
  selectedCells,
  multiCellResults,
  setMultiCellResults,
  updateOneCellStatus,
  updateOneCellIteration,
  updateOneCellTraces,
  visibleCellIndices,
} from './multi-cell-store';
import { extractCellTrace } from './array-utils';
import { computePaddedWindow, computeSafeMargin, WarmStartCache } from './warm-start-cache';
import { createWorkerPool, type WorkerPool } from './worker-pool';
import type { SolverParams } from './solver-types';
import type { NpyResult } from './types';

const DEBOUNCE_MS = 30;
const QUANTUM_ITERATIONS = 15;

interface CellSolveState {
  cellIndex: number;
  rawTrace: Float64Array;
  zoomStart: number;  // seconds
  zoomEnd: number;    // seconds
  warmStartCache: WarmStartCache;
  activeJobId: number | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  converged: boolean;
  deferredRequeue: boolean;
  dispatchedParams: SolverParams | null;
  // Cached padded result for zoom-without-re-solve
  paddedResultStart: number;
  paddedResultEnd: number;
  fullPaddedSolution: Float32Array | null;
  fullPaddedReconvolution: Float32Array | null;
}

let pool: WorkerPool | null = null;
let jobCounter = 0;
const cellStates = new Map<number, CellSolveState>();

function nextJobId(): number {
  return ++jobCounter;
}

function getCurrentParams(): SolverParams {
  return {
    tauRise: tauRise(),
    tauDecay: tauDecay(),
    lambda: lambda(),
    fs: samplingRate() ?? 30,
  };
}

function getCellPriority(cellIndex: number): number {
  if (cellIndex === selectedCell()) return 0;   // active (last-clicked)
  if (visibleCellIndices().has(cellIndex)) return 1; // visible
  return 2;                                     // off-screen
}

function dispatchCellSolve(state: CellSolveState): void {
  if (!pool) return;

  const params = getCurrentParams();
  const fs = params.fs;
  const traceLen = state.rawTrace.length;

  // Convert zoom seconds → sample indices
  const visibleStart = Math.max(0, Math.floor(state.zoomStart * fs));
  const visibleEnd = Math.min(traceLen, Math.ceil(state.zoomEnd * fs));
  if (visibleStart >= visibleEnd) return;

  // Compute padded window
  const { paddedStart, paddedEnd, resultOffset, resultLength } =
    computePaddedWindow(visibleStart, visibleEnd, traceLen, params.tauDecay, fs);

  // Extract padded trace subarray (copy for transfer)
  const paddedTrace = new Float64Array(state.rawTrace.subarray(paddedStart, paddedEnd));

  // Get warm-start strategy
  const { strategy, state: warmState } =
    state.warmStartCache.getStrategy(params, paddedStart, paddedEnd);

  // Cancel any in-flight job for this cell
  if (state.activeJobId !== null) {
    pool.cancel(state.activeJobId);
    state.activeJobId = null;
  }

  const jobId = nextJobId();
  state.activeJobId = jobId;
  state.converged = false;
  state.deferredRequeue = false;
  state.dispatchedParams = { ...params };

  updateOneCellStatus(state.cellIndex, 'solving');

  pool.dispatch({
    jobId,
    trace: paddedTrace,
    params,
    warmState,
    warmStrategy: strategy,
    getPriority: () => getCellPriority(state.cellIndex),
    maxIterations: QUANTUM_ITERATIONS,
    onIntermediate(solution, reconvolution, iteration) {
      if (state.activeJobId !== jobId) return; // stale
      // Store full padded result for zoom-without-re-solve
      state.fullPaddedSolution = new Float32Array(solution);
      state.fullPaddedReconvolution = new Float32Array(reconvolution);
      state.paddedResultStart = paddedStart;
      state.paddedResultEnd = paddedEnd;
      // Extract visible region from padded result
      const visSol = new Float32Array(solution.subarray(resultOffset, resultOffset + resultLength));
      const visReconv = new Float32Array(reconvolution.subarray(resultOffset, resultOffset + resultLength));
      updateOneCellTraces(state.cellIndex, visSol, visReconv, visibleStart);
      updateOneCellIteration(state.cellIndex, iteration);
    },
    onComplete(solution, reconvolution, solverState, iterations, converged) {
      if (state.activeJobId !== jobId) return; // stale
      state.activeJobId = null;
      state.converged = converged;
      // Store full padded result for zoom-without-re-solve
      state.fullPaddedSolution = new Float32Array(solution);
      state.fullPaddedReconvolution = new Float32Array(reconvolution);
      state.paddedResultStart = paddedStart;
      state.paddedResultEnd = paddedEnd;
      // Extract visible region
      const visSol = new Float32Array(solution.subarray(resultOffset, resultOffset + resultLength));
      const visReconv = new Float32Array(reconvolution.subarray(resultOffset, resultOffset + resultLength));
      updateOneCellTraces(state.cellIndex, visSol, visReconv, visibleStart);
      updateOneCellIteration(state.cellIndex, iterations);
      // Cache warm-start state
      state.warmStartCache.store(solverState, params, paddedStart, paddedEnd);

      if (converged) {
        updateOneCellStatus(state.cellIndex, 'fresh');
        // A cell finished — dispatch any deferred off-screen cells
        drainDeferredCells();
      } else {
        // Not converged — re-enqueue for another quantum
        reEnqueueCell(state);
      }
    },
    onCancelled() {
      if (state.activeJobId === jobId) state.activeJobId = null;
    },
    onError(message) {
      if (state.activeJobId !== jobId) return; // stale
      state.activeJobId = null;
      console.error(`Solver error for cell ${state.cellIndex}:`, message);
      updateOneCellStatus(state.cellIndex, 'error');
    },
  });
}

function hasUnconvergedVisibleCells(): boolean {
  const visible = visibleCellIndices();
  const active = selectedCell();
  for (const s of cellStates.values()) {
    if (s.converged) continue;
    if (s.cellIndex === active || visible.has(s.cellIndex)) return true;
  }
  return false;
}

function drainDeferredCells(): void {
  for (const s of cellStates.values()) {
    if (s.deferredRequeue) {
      s.deferredRequeue = false;
      dispatchCellSolve(s);
    }
  }
}

function reEnqueueCell(state: CellSolveState): void {
  if (!pool) return;
  // Don't re-enqueue if params changed (Effect 2 handles it)
  const current = getCurrentParams();
  if (
    state.dispatchedParams &&
    (state.dispatchedParams.tauRise !== current.tauRise ||
      state.dispatchedParams.tauDecay !== current.tauDecay ||
      state.dispatchedParams.lambda !== current.lambda ||
      state.dispatchedParams.fs !== current.fs)
  )
    return;
  // Don't re-enqueue if cell was deselected
  if (!cellStates.has(state.cellIndex)) return;

  // Defer off-screen cells while visible/active cells are still solving
  if (getCellPriority(state.cellIndex) > 1 && hasUnconvergedVisibleCells()) {
    state.deferredRequeue = true;
    return;
  }

  dispatchCellSolve(state);
}

function debouncedDispatch(state: CellSolveState): void {
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer);
  }
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    dispatchCellSolve(state);
  }, DEBOUNCE_MS);
}

function ensureCellState(cellIndex: number, data: NpyResult, shape: [number, number], isSwapped: boolean): CellSolveState {
  let state = cellStates.get(cellIndex);
  if (!state) {
    const rawTrace = extractCellTrace(cellIndex, data, shape, isSwapped);
    const fs = samplingRate() ?? 30;
    const duration = rawTrace.length / fs;
    state = {
      cellIndex,
      rawTrace,
      zoomStart: 0,
      zoomEnd: duration,
      warmStartCache: new WarmStartCache(),
      activeJobId: null,
      debounceTimer: null,
      converged: false,
      deferredRequeue: false,
      dispatchedParams: null,
      paddedResultStart: 0,
      paddedResultEnd: 0,
      fullPaddedSolution: null,
      fullPaddedReconvolution: null,
    };
    cellStates.set(cellIndex, state);

    // Ensure the cell has an entry in multiCellResults for immediate card rendering
    const results = multiCellResults();
    if (!results.has(cellIndex)) {
      const zeros = new Float32Array(rawTrace.length);
      const next = new Map(results);
      next.set(cellIndex, { cellIndex, raw: rawTrace, deconvolved: zeros, reconvolution: zeros });
      setMultiCellResults(next);
    }
  }
  return state;
}

function removeCellState(cellIndex: number): void {
  const state = cellStates.get(cellIndex);
  if (state) {
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    if (state.activeJobId !== null && pool) pool.cancel(state.activeJobId);
    cellStates.delete(cellIndex);
  }
}

export function reportCellZoom(cellIndex: number, startS: number, endS: number): void {
  const state = cellStates.get(cellIndex);
  if (!state) return;
  state.zoomStart = startS;
  state.zoomEnd = endS;

  // Check if new zoom fits within the cached padded result (skip re-solve)
  if (state.fullPaddedSolution && state.fullPaddedReconvolution) {
    const params = getCurrentParams();
    const fs = params.fs;
    const traceLen = state.rawTrace.length;
    const newVisStart = Math.max(0, Math.floor(startS * fs));
    const newVisEnd = Math.min(traceLen, Math.ceil(endS * fs));
    const safeMargin = computeSafeMargin(params.tauDecay, fs);
    const safeStart = state.paddedResultStart + safeMargin;
    const safeEnd = state.paddedResultEnd - safeMargin;

    if (newVisStart >= safeStart && newVisEnd <= safeEnd && newVisStart < newVisEnd) {
      // Cancel any in-flight solver — its callbacks have stale window offsets
      // that would overwrite the correctly-aligned slice we're about to set
      if (state.activeJobId !== null && pool) {
        pool.cancel(state.activeJobId);
        state.activeJobId = null;
      }
      // Extract from cached result — no re-solve needed
      const offsetInPadded = newVisStart - state.paddedResultStart;
      const length = newVisEnd - newVisStart;
      const visSol = new Float32Array(state.fullPaddedSolution.subarray(offsetInPadded, offsetInPadded + length));
      const visReconv = new Float32Array(state.fullPaddedReconvolution.subarray(offsetInPadded, offsetInPadded + length));
      updateOneCellTraces(cellIndex, visSol, visReconv, newVisStart);
      // If still solving (round-robin), re-enqueue to continue convergence
      if (!state.converged) {
        debouncedDispatch(state);
      }
      return;
    }
  }

  // Outside cached bounds — cancel in-flight, debounce, re-dispatch
  if (state.activeJobId !== null && pool) {
    pool.cancel(state.activeJobId);
    state.activeJobId = null;
  }
  // Only reset iteration count if cell had converged; mid-solve cells keep progress
  if (state.converged) {
    updateOneCellStatus(cellIndex, 'stale');
  }
  debouncedDispatch(state);
}

export function initCellSolveManager(): void {
  pool = createWorkerPool();

  // Effect 1: Watch selectedCells — add/remove cell states and dispatch initial solves
  createEffect(
    on(selectedCells, (cells) => {
      const data = parsedData();
      const shape = effectiveShape();
      const isSwapped = swapped();
      if (!data || !shape) return;

      const currentSet = new Set(cells);
      const existingCells = new Set(cellStates.keys());

      // Remove states for deselected cells
      for (const idx of existingCells) {
        if (!currentSet.has(idx)) {
          removeCellState(idx);
        }
      }

      // Add states and dispatch only for newly added cells
      for (const cellIndex of cells) {
        const isNew = !existingCells.has(cellIndex);
        const state = ensureCellState(cellIndex, data, shape, isSwapped);
        if (isNew) {
          dispatchCellSolve(state);
        }
      }
    }),
  );

  // Effect 2: Watch global params — mark all cells stale, cancel all, re-dispatch all
  createEffect(
    on([tauRise, tauDecay, lambda], () => {
      if (cellStates.size === 0) return;

      // Cancel everything
      if (pool) pool.cancelAll();

      // Mark all stale and clear cached padded results
      for (const state of cellStates.values()) {
        state.activeJobId = null;
        state.converged = false;
        state.deferredRequeue = false;
        state.dispatchedParams = null;
        state.fullPaddedSolution = null;
        state.fullPaddedReconvolution = null;
        updateOneCellStatus(state.cellIndex, 'stale');
      }

      // Re-dispatch with debounce — 3-tier priority: active → visible → off-screen
      const active = selectedCell();
      const visible = visibleCellIndices();
      const activeStates: CellSolveState[] = [];
      const visibleStates: CellSolveState[] = [];
      const offScreenStates: CellSolveState[] = [];
      for (const state of cellStates.values()) {
        if (state.cellIndex === active) {
          activeStates.push(state);
        } else if (visible.has(state.cellIndex)) {
          visibleStates.push(state);
        } else {
          offScreenStates.push(state);
        }
      }
      for (const state of activeStates) debouncedDispatch(state);
      for (const state of visibleStates) debouncedDispatch(state);
      for (const state of offScreenStates) debouncedDispatch(state);
    }),
  );

  onCleanup(() => {
    disposeCellSolveManager();
  });
}

export function disposeCellSolveManager(): void {
  // Clear all debounce timers
  for (const state of cellStates.values()) {
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
  }
  cellStates.clear();

  if (pool) {
    pool.dispose();
    pool = null;
  }
}
