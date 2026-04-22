// Reactive state for multi-cell selection and results.
// Uses SolidJS stores for per-cell data (multiCellResults, cellSolverStatuses,
// cellIterationCounts) to enable granular reactivity and avoid Map cloning.
// Other signals use the standard createSignal pattern.

import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { CellSolverStatus } from '@calab/core';
import { rankCellsByActivity, sampleRandomCells } from '@calab/io';
import { parsedData, effectiveShape, swapped } from './data-store.ts';

// --- Types ---

export type SelectionMode = 'top-active' | 'random' | 'manual';

/** Z-score parameters derived from a raw trace. Computed once at ingest. */
export interface RawTraceStats {
  mean: number;
  std: number;
  zMin: number;
  zMax: number;
}

export interface CellTraces {
  cellIndex: number;
  raw: Float64Array;
  /** Precomputed raw-trace z-score stats. Constant per cell once set. */
  rawStats: RawTraceStats;
  deconvolved: Float32Array;
  /** [min, max] of the deconvolved trace. Updated on every solver tick. */
  deconvMinMax: [number, number];
  reconvolution: Float32Array;
  filteredTrace?: Float32Array;
  windowStartSample?: number;
}

/** Compute z-score stats for a raw trace. Zero-length input yields identity stats. */
export function computeRawStats(raw: Float64Array): RawTraceStats {
  if (raw.length === 0) return { mean: 0, std: 1, zMin: 0, zMax: 0 };
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    sum += v;
    sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const n = raw.length;
  const mean = sum / n;
  const std = Math.sqrt(sumSq / n - mean * mean) || 1;
  return { mean, std, zMin: (min - mean) / std, zMax: (max - mean) / std };
}

/** [min, max] over a typed array. Empty input yields [0, 0]. */
export function computeArrayMinMax(arr: ArrayLike<number>): [number, number] {
  if (arr.length === 0) return [0, 0];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

// Record types for store-backed per-cell data.
// Using Record<number, X> instead of Map<number, X> enables SolidJS
// to track each cell index as a separate reactive property.
type CellResultsStore = Record<number, CellTraces>;
type CellStatusStore = Record<number, CellSolverStatus>;
type CellIterationStore = Record<number, number>;

// --- Signals ---

const [selectionMode, setSelectionMode] = createSignal<SelectionMode>('top-active');
const [selectedCells, setSelectedCells] = createSignal<number[]>([]);
const [displayCount, setDisplayCount] = createSignal<number>(5);
const [multiCellSolving, setMultiCellSolving] = createSignal<boolean>(false);
const [multiCellProgress, setMultiCellProgress] = createSignal<{
  current: number;
  total: number;
} | null>(null);
const [solvingCells, setSolvingCells] = createSignal<ReadonlySet<number>>(new Set());
const [activelySolvingCell, setActivelySolvingCell] = createSignal<number | null>(null);
const [activityRanking, setActivityRanking] = createSignal<number[] | null>(null);
const [gridColumns, setGridColumns] = createSignal<number>(2);

// --- Per-cell stores (granular reactivity, no Map cloning) ---

const [multiCellResults, setMultiCellResults] = createStore<CellResultsStore>({});
const [cellSolverStatuses, setCellSolverStatuses] = createStore<CellStatusStore>({});
const [cellIterationCounts, setCellIterationCounts] = createStore<CellIterationStore>({});

// --- Viewport visibility tracking ---
const [visibleCellIndices, setVisibleCellIndices] = createSignal<ReadonlySet<number>>(new Set());

// --- Hover tracking (for solver priority boost) ---
const [hoveredCell, setHoveredCell] = createSignal<number | null>(null);

// --- Pinned multi-cell results for before/after comparison ---
// Pinned results are a snapshot (read-only after creation), so a store
// gives us the same granular reads without cloning on pin.
const [pinnedMultiCellResults, setPinnedMultiCellResults] = createStore<CellResultsStore>({});

// --- Per-cell update helpers ---

function updateOneCellStatus(cellIndex: number, status: CellSolverStatus): void {
  // Solid stores default to equals:false — without this guard, repeat writes
  // (e.g., marking 'stale' every slider tick during a drag) retrigger every
  // subscriber (QualityBadge, cell-card status class) even when nothing changed.
  if (cellSolverStatuses[cellIndex] === status) return;
  setCellSolverStatuses(cellIndex, status);
  if (status === 'stale') {
    setCellIterationCounts(cellIndex, 0);
  }
}

function updateOneCellIteration(cellIndex: number, iteration: number): void {
  setCellIterationCounts(cellIndex, iteration);
}

function updateOneCellTraces(
  cellIndex: number,
  deconvolved: Float32Array,
  reconvolution: Float32Array,
  windowStartSample?: number,
  filteredTrace?: Float32Array,
): void {
  const existing = multiCellResults[cellIndex];
  if (!existing) return;
  setMultiCellResults(cellIndex, {
    ...existing,
    deconvolved,
    deconvMinMax: computeArrayMinMax(deconvolved),
    reconvolution,
    filteredTrace,
    windowStartSample,
  });
}

// --- Actions ---

/**
 * Compute and cache the activity ranking for the current dataset.
 * Call this once when data is loaded. Reads parsedData, effectiveShape,
 * and swapped from the data store.
 */
function computeAndCacheRanking(): void {
  const data = parsedData();
  const shape = effectiveShape();
  const isSwapped = swapped();

  if (!data || !shape) return;

  const ranking = rankCellsByActivity(data, shape, isSwapped);
  setActivityRanking(ranking);
}

/**
 * Update the selected cells based on the current selection mode and display count.
 * - 'top-active': take first displayCount entries from cached activity ranking
 * - 'random': sample displayCount random cells
 * - 'manual': leave selectedCells unchanged (user controls directly)
 */
function updateCellSelection(): void {
  const mode = selectionMode();
  const count = displayCount();

  if (mode === 'manual') return;

  if (mode === 'top-active') {
    const ranking = activityRanking();
    if (!ranking) return;
    setSelectedCells(ranking.slice(0, count));
    return;
  }

  if (mode === 'random') {
    const shape = effectiveShape();
    if (!shape) return;
    const [numCells] = shape;
    setSelectedCells(sampleRandomCells(numCells, count));
  }
}

/** Snapshot current multi-cell results for pinned overlay comparison. */
function pinMultiCellResults(): void {
  const snapshot: CellResultsStore = {};
  for (const key of Object.keys(multiCellResults)) {
    const cellIdx = Number(key);
    const traces = multiCellResults[cellIdx];
    if (!traces) continue;
    snapshot[cellIdx] = {
      ...traces,
      deconvolved: new Float32Array(traces.deconvolved),
      reconvolution: new Float32Array(traces.reconvolution),
    };
  }
  setPinnedMultiCellResults(reconcile(snapshot));
}

/** Clear pinned multi-cell results. */
function unpinMultiCellResults(): void {
  setPinnedMultiCellResults(reconcile({}));
}

/**
 * Reset all multi-cell state (results + selection). Use when switching datasets.
 */
function clearMultiCellState(): void {
  setMultiCellResults(reconcile({}));
  setCellSolverStatuses(reconcile({}));
  setCellIterationCounts(reconcile({}));
  setSelectedCells([]);
  setSolvingCells(new Set<number>());
  setActivelySolvingCell(null);
  setActivityRanking(null);
  setSelectionMode('top-active');
}

// --- Exports ---

export {
  // Getters (signals and stores)
  selectionMode,
  selectedCells,
  displayCount,
  multiCellResults,
  multiCellSolving,
  multiCellProgress,
  solvingCells,
  activelySolvingCell,
  activityRanking,
  gridColumns,
  cellSolverStatuses,
  cellIterationCounts,
  pinnedMultiCellResults,
  visibleCellIndices,
  hoveredCell,
  // Setters
  setSelectionMode,
  setSelectedCells,
  setDisplayCount,
  setMultiCellResults,
  setMultiCellSolving,
  setMultiCellProgress,
  setSolvingCells,
  setActivelySolvingCell,
  setActivityRanking,
  setGridColumns,
  setCellSolverStatuses,
  setVisibleCellIndices,
  setHoveredCell,
  // Per-cell helpers
  updateOneCellStatus,
  updateOneCellIteration,
  updateOneCellTraces,
  // Actions
  computeAndCacheRanking,
  updateCellSelection,
  clearMultiCellState,
  pinMultiCellResults,
  unpinMultiCellResults,
};
