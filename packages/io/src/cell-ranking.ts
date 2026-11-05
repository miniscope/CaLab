// Cell activity ranking and random sampling utilities
// Pure functions for selecting which cells to display in multi-trace view

import type { NpyResult } from '@calab/core';
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

/**
 * Pick `count` cells spread across the SNR distribution, so tuning sees weak,
 * typical and strong cells instead of only the most active ones.
 *
 * Cells are ranked by SNR and taken at the quantiles (i + 0.5) / count (for
 * count = 5: the 10th, 30th, 50th, 70th and 90th percentiles). Non-finite
 * SNRs are ignored. Returns strongest first. Never returns duplicates; fewer
 * than `count` finite cells yields all of them.
 *
 * @param snr - SNR per cell, indexed by cell id
 * @param count - Number of cells wanted
 * @param among - Optional candidate ids (e.g. a histogram brush); default all cells
 */
export function pickSnrSpread(
  snr: ArrayLike<number>,
  count: number,
  among?: readonly number[],
): number[] {
  const ids: number[] = [];
  const candidates = among ?? Array.from({ length: snr.length }, (_, i) => i);
  for (const id of candidates) if (Number.isFinite(snr[id])) ids.push(id);
  if (ids.length === 0 || count <= 0) return [];
  ids.sort((a, b) => snr[a] - snr[b] || a - b);
  if (count >= ids.length) return ids.reverse();
  const picked: number[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(ids[Math.round(((i + 0.5) / count) * (ids.length - 1))]);
  }
  return [...new Set(picked)].reverse();
}
