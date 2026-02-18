// Cell Solve Manager: reactive orchestrator for parallel windowed solving.
// Watches selectedCells + global params, dispatches per-cell jobs through the worker pool.
// Replaces multi-cell-solver.ts, tuning-orchestrator.ts, and job-scheduler.ts.

import { createEffect, on, onCleanup } from 'solid-js';
import { tauRise, tauDecay, lambda, selectedCell, filterEnabled } from './viz-store.ts';
import { parsedData, effectiveShape, swapped, samplingRate } from './data-store.ts';
import {
  selectedCells,
  multiCellResults,
  setMultiCellResults,
  updateOneCellStatus,
  updateOneCellIteration,
  updateOneCellTraces,
  visibleCellIndices,
  hoveredCell,
} from './multi-cell-store.ts';
import { extractCellTrace } from './array-utils.ts';
import { computePaddedWindow, computeSafeMargin, WarmStartCache } from './warm-start-cache.ts';
import { createWorkerPool, type WorkerPool } from './worker-pool.ts';
import type { SolverParams } from './solver-types.ts';
import type { NpyResult } from './types.ts';

const DEBOUNCE_MS = 30;
// With FFT convolutions each iteration is very fast (~0.1-1ms depending on trace length).
// Small quanta cause excessive main-thread overhead from complete→re-enqueue→dispatch round-trips,
// starving the UI event loop. 200 iterations keeps quanta under ~40ms for typical traces while
// reducing round-trip overhead by ~13×. Cancel responsiveness is still ~2ms via BATCH_SIZE yields.
const QUANTUM_ITERATIONS = 200;
const DEFAULT_ZOOM_WINDOW_S = 20;

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
  fullPaddedFilteredTrace: Float32Array | null;
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
    filterEnabled: filterEnabled(),
  };
}

function getCellPriority(cellIndex: number): number {
  if (cellIndex === selectedCell()) return 0;        // active (last-clicked)
  if (cellIndex === hoveredCell()) return 0;         // hovered
  if (visibleCellIndices().has(cellIndex)) return 1; // visible
  return 2;                                          // off-screen
}

function cancelActiveJob(state: CellSolveState): void {
  if (state.activeJobId !== null && pool) {
    pool.cancel(state.activeJobId);
    state.activeJobId = null;
  }
}

/** Cache the full padded result and update the visible slice for a cell. */
function cachePaddedAndUpdateTraces(
  state: CellSolveState,
  solution: Float32Array,
  reconvolution: Float32Array,
  paddedStart: number,
  paddedEnd: number,
  resultOffset: number,
  resultLength: number,
  visibleStart: number,
  iteration: number,
  filteredTrace?: Float32Array,
): void {
  state.fullPaddedSolution = new Float32Array(solution);
  state.fullPaddedReconvolution = new Float32Array(reconvolution);
  state.fullPaddedFilteredTrace = filteredTrace ? new Float32Array(filteredTrace) : null;
  state.paddedResultStart = paddedStart;
  state.paddedResultEnd = paddedEnd;

  const visSol = new Float32Array(solution.subarray(resultOffset, resultOffset + resultLength));
  const visReconv = new Float32Array(reconvolution.subarray(resultOffset, resultOffset + resultLength));
  const visFiltered = filteredTrace
    ? new Float32Array(filteredTrace.subarray(resultOffset, resultOffset + resultLength))
    : undefined;
  updateOneCellTraces(state.cellIndex, visSol, visReconv, visibleStart, visFiltered);
  updateOneCellIteration(state.cellIndex, iteration);
}

function dispatchCellSolve(state: CellSolveState): void {
  if (!pool) return;

  const params = getCurrentParams();
  const fs = params.fs;
  const traceLen = state.rawTrace.length;

  // Convert zoom seconds to sample indices
  const visibleStart = Math.max(0, Math.floor(state.zoomStart * fs));
  const visibleEnd = Math.min(traceLen, Math.ceil(state.zoomEnd * fs));
  if (visibleStart >= visibleEnd) return;

  const { paddedStart, paddedEnd, resultOffset, resultLength } =
    computePaddedWindow(visibleStart, visibleEnd, traceLen, params.tauDecay, fs);

  const paddedTrace = new Float32Array(state.rawTrace.subarray(paddedStart, paddedEnd));
  const { strategy, state: warmState } =
    state.warmStartCache.getStrategy(params, paddedStart, paddedEnd);

  cancelActiveJob(state);

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
      if (state.activeJobId !== jobId) return;
      cachePaddedAndUpdateTraces(
        state, solution, reconvolution,
        paddedStart, paddedEnd, resultOffset, resultLength,
        visibleStart, iteration,
      );
    },
    onComplete(solution, reconvolution, solverState, iterations, converged, filteredTrace) {
      if (state.activeJobId !== jobId) return;
      state.activeJobId = null;
      state.converged = converged;
      cachePaddedAndUpdateTraces(
        state, solution, reconvolution,
        paddedStart, paddedEnd, resultOffset, resultLength,
        visibleStart, iterations, filteredTrace,
      );
      state.warmStartCache.store(solverState, params, paddedStart, paddedEnd);

      if (converged) {
        updateOneCellStatus(state.cellIndex, 'fresh');
        drainDeferredCells();
      } else {
        reEnqueueCell(state);
      }
    },
    onCancelled() {
      if (state.activeJobId === jobId) state.activeJobId = null;
    },
    onError(message) {
      if (state.activeJobId !== jobId) return;
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

function paramsMatch(a: SolverParams, b: SolverParams): boolean {
  return a.tauRise === b.tauRise && a.tauDecay === b.tauDecay
    && a.lambda === b.lambda && a.fs === b.fs
    && a.filterEnabled === b.filterEnabled;
}

function reEnqueueCell(state: CellSolveState): void {
  if (!pool) return;
  // Don't re-enqueue if params changed (Effect 2 handles it)
  if (state.dispatchedParams && !paramsMatch(state.dispatchedParams, getCurrentParams())) return;
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
      zoomEnd: Math.min(DEFAULT_ZOOM_WINDOW_S, duration),
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
      fullPaddedFilteredTrace: null,
    };
    cellStates.set(cellIndex, state);

    // Ensure the cell has an entry in multiCellResults for immediate card rendering
    if (multiCellResults[cellIndex] === undefined) {
      const zeros = new Float32Array(rawTrace.length);
      setMultiCellResults(cellIndex, { cellIndex, raw: rawTrace, deconvolved: zeros, reconvolution: zeros });
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

/** Check whether a zoom window fits within the artifact-safe region of the cached padded result. */
function tryExtractFromCache(state: CellSolveState, newVisStart: number, newVisEnd: number): boolean {
  if (!state.fullPaddedSolution || !state.fullPaddedReconvolution) return false;

  const params = getCurrentParams();
  const safeMargin = computeSafeMargin(params.tauDecay, params.fs);
  const safeStart = state.paddedResultStart + safeMargin;
  const safeEnd = state.paddedResultEnd - safeMargin;

  if (newVisStart < safeStart || newVisEnd > safeEnd || newVisStart >= newVisEnd) return false;

  // Cancel in-flight solver whose callbacks have stale window offsets
  cancelActiveJob(state);

  const offsetInPadded = newVisStart - state.paddedResultStart;
  const length = newVisEnd - newVisStart;
  const visSol = new Float32Array(state.fullPaddedSolution.subarray(offsetInPadded, offsetInPadded + length));
  const visReconv = new Float32Array(state.fullPaddedReconvolution.subarray(offsetInPadded, offsetInPadded + length));
  const visFiltered = state.fullPaddedFilteredTrace
    ? new Float32Array(state.fullPaddedFilteredTrace.subarray(offsetInPadded, offsetInPadded + length))
    : undefined;
  updateOneCellTraces(state.cellIndex, visSol, visReconv, newVisStart, visFiltered);
  return true;
}

export function reportCellZoom(cellIndex: number, startS: number, endS: number): void {
  const state = cellStates.get(cellIndex);
  if (!state) return;
  state.zoomStart = startS;
  state.zoomEnd = endS;

  const params = getCurrentParams();
  const fs = params.fs;
  const newVisStart = Math.max(0, Math.floor(startS * fs));
  const newVisEnd = Math.min(state.rawTrace.length, Math.ceil(endS * fs));

  if (tryExtractFromCache(state, newVisStart, newVisEnd)) {
    // Cache hit — re-enqueue only if still converging
    if (!state.converged) debouncedDispatch(state);
    return;
  }

  // Cache miss — cancel in-flight, debounce, re-dispatch
  cancelActiveJob(state);
  if (state.converged) updateOneCellStatus(cellIndex, 'stale');
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
    on([tauRise, tauDecay, lambda, filterEnabled], () => {
      if (cellStates.size === 0) return;

      // Cancel everything
      if (pool) pool.cancelAll();

      // Mark all stale, clear cached padded results, and re-dispatch.
      // Priority ordering is handled by the worker pool's priority queue
      // via each job's getPriority callback, so dispatch order doesn't matter.
      for (const state of cellStates.values()) {
        state.activeJobId = null;
        state.converged = false;
        state.deferredRequeue = false;
        state.dispatchedParams = null;
        state.fullPaddedSolution = null;
        state.fullPaddedReconvolution = null;
        state.fullPaddedFilteredTrace = null;
        updateOneCellStatus(state.cellIndex, 'stale');
        debouncedDispatch(state);
      }
    }),
  );

  onCleanup(disposeCellSolveManager);
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
