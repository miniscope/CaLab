// Cell Solve Manager: reactive orchestrator for parallel windowed solving.
// Watches selectedCells + global params, dispatches per-cell jobs through the worker pool.
// Replaces multi-cell-solver.ts, tuning-orchestrator.ts, and job-scheduler.ts.

import { createEffect, on, onCleanup } from 'solid-js';
import { tauRise, tauDecay, lambda } from './viz-store';
import { parsedData, effectiveShape, swapped, samplingRate } from './data-store';
import {
  selectedCells,
  multiCellResults,
  setMultiCellResults,
  updateOneCellStatus,
  updateOneCellTraces,
} from './multi-cell-store';
import { extractCellTrace } from './array-utils';
import { computePaddedWindow, WarmStartCache } from './warm-start-cache';
import { createWorkerPool, type WorkerPool } from './worker-pool';
import type { SolverParams } from './solver-types';
import type { NpyResult } from './types';

const DEBOUNCE_MS = 30;

interface CellSolveState {
  cellIndex: number;
  rawTrace: Float64Array;
  zoomStart: number;  // seconds
  zoomEnd: number;    // seconds
  warmStartCache: WarmStartCache;
  activeJobId: number | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
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

  updateOneCellStatus(state.cellIndex, 'solving');

  pool.dispatch({
    jobId,
    trace: paddedTrace,
    params,
    warmState,
    warmStrategy: strategy,
    onIntermediate(solution, reconvolution, _iteration) {
      if (state.activeJobId !== jobId) return; // stale
      // Extract visible region from padded result
      const visSol = new Float32Array(solution.subarray(resultOffset, resultOffset + resultLength));
      const visReconv = new Float32Array(reconvolution.subarray(resultOffset, resultOffset + resultLength));
      updateOneCellTraces(state.cellIndex, visSol, visReconv, visibleStart);
    },
    onComplete(solution, reconvolution, solverState, _iterations, _converged) {
      if (state.activeJobId !== jobId) return; // stale
      state.activeJobId = null;
      // Extract visible region
      const visSol = new Float32Array(solution.subarray(resultOffset, resultOffset + resultLength));
      const visReconv = new Float32Array(reconvolution.subarray(resultOffset, resultOffset + resultLength));
      updateOneCellTraces(state.cellIndex, visSol, visReconv, visibleStart);
      // Cache warm-start state
      state.warmStartCache.store(solverState, params, paddedStart, paddedEnd);
      updateOneCellStatus(state.cellIndex, 'fresh');
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

  // Cancel in-flight, debounce, re-dispatch just this cell
  if (state.activeJobId !== null && pool) {
    pool.cancel(state.activeJobId);
    state.activeJobId = null;
  }
  updateOneCellStatus(cellIndex, 'stale');
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

      // Mark all stale and re-dispatch with debounce
      for (const state of cellStates.values()) {
        state.activeJobId = null;
        updateOneCellStatus(state.cellIndex, 'stale');
        debouncedDispatch(state);
      }
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
