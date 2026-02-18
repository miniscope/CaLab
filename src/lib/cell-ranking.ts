// Cell activity ranking and random sampling utilities
// Pure functions for selecting which cells to display in multi-trace view

import type { NpyResult } from './types.ts';
import { extractCellTrace } from './array-utils.ts';

/**
 * Rank all cells by activity level (variance of raw trace).
 *
 * Uses single-pass variance computation: var = sumSq/n - mean^2.
 * Follows the same flat-array indexing pattern as viz-store loadCellTraces().
 *
 * @param data - Parsed NPY result with flat typed array
 * @param shape - Effective [numCells, numTimepoints] after optional swap
 * @param isSwapped - Whether the user swapped dimensions
 * @returns Array of cell indices sorted by descending activity (most active first)
 */
export function rankCellsByActivity(
  data: NpyResult,
  shape: [number, number],
  isSwapped: boolean,
): number[] {
  const [numCells, numTimepoints] = shape;

  if (numCells === 0 || numTimepoints === 0) return [];

  // Compute variance for each cell
  const variances: { cellIndex: number; variance: number }[] = [];

  for (let c = 0; c < numCells; c++) {
    const trace = extractCellTrace(c, data, shape, isSwapped);
    let sum = 0;
    let sumSq = 0;

    for (let t = 0; t < numTimepoints; t++) {
      const val = trace[t];
      sum += val;
      sumSq += val * val;
    }

    const mean = sum / numTimepoints;
    const variance = sumSq / numTimepoints - mean * mean;
    variances.push({ cellIndex: c, variance });
  }

  // Sort by descending variance (most active first)
  variances.sort((a, b) => b.variance - a.variance);

  return variances.map((v) => v.cellIndex);
}

/**
 * Sample n random cell indices using Fisher-Yates partial shuffle.
 *
 * Only shuffles the first min(n, totalCells) elements for efficiency.
 * Uses Math.random() -- selection is a UI convenience, not scientific
 * reproducibility.
 *
 * @param totalCells - Total number of cells available
 * @param n - Number of cells to sample
 * @returns Array of n random cell indices (or all if n >= totalCells)
 */
export function sampleRandomCells(totalCells: number, n: number): number[] {
  if (totalCells <= 0) return [];

  const count = Math.min(n, totalCells);

  // Create array of all cell indices
  const indices = Array.from({ length: totalCells }, (_, i) => i);

  // Fisher-Yates partial shuffle: only shuffle first `count` elements
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (totalCells - i));
    // Swap indices[i] and indices[j]
    const temp = indices[i];
    indices[i] = indices[j];
    indices[j] = temp;
  }

  return indices.slice(0, count);
}
