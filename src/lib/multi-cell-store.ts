// Reactive state for multi-cell selection and results
// Uses SolidJS signals matching project pattern of module-level signals with named exports

import { createSignal } from 'solid-js';
import { rankCellsByActivity, sampleRandomCells } from './cell-ranking';
import { parsedData, effectiveShape, swapped } from './data-store';

// --- Types ---

export type SelectionMode = 'top-active' | 'random' | 'manual';

export interface CellTraces {
  cellIndex: number;
  raw: Float64Array;
  deconvolved: Float64Array;
  reconvolution: Float64Array;
}

// --- Signals ---

const [selectionMode, setSelectionMode] = createSignal<SelectionMode>('top-active');
const [selectedCells, setSelectedCells] = createSignal<number[]>([]);
const [displayCount, setDisplayCount] = createSignal<number>(5);
const [multiCellResults, setMultiCellResults] = createSignal<Map<number, CellTraces>>(new Map());
const [multiCellSolving, setMultiCellSolving] = createSignal<boolean>(false);
const [multiCellProgress, setMultiCellProgress] = createSignal<{ current: number; total: number } | null>(null);
const [solvingCells, setSolvingCells] = createSignal<ReadonlySet<number>>(new Set());
const [activelySolvingCell, setActivelySolvingCell] = createSignal<number | null>(null);
const [activityRanking, setActivityRanking] = createSignal<number[] | null>(null);
const [gridColumns, setGridColumns] = createSignal<number>(2);

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

/**
 * Clear all multi-cell solver results (e.g., when parameters change).
 */
function clearMultiCellResults(): void {
  setMultiCellResults(new Map());
}

/**
 * Reset all multi-cell state (results + selection). Use when switching datasets.
 */
function clearMultiCellState(): void {
  setMultiCellResults(new Map());
  setSelectedCells([]);
  setSolvingCells(new Set<number>());
  setActivelySolvingCell(null);
  setActivityRanking(null);
  setSelectionMode('top-active');
}

// --- Exports ---

export {
  // Getters (signals)
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
  // Actions
  computeAndCacheRanking,
  updateCellSelection,
  clearMultiCellResults,
  clearMultiCellState,
};
