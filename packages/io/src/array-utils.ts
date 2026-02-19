// Shared array utilities for cell trace extraction and Fortran-to-C transpose.

import type { NpyResult, NumericTypedArray } from '@calab/core';

/**
 * Extract a single cell's fluorescence trace from a flat typed array.
 *
 * Handles both normal [cells, timepoints] and swapped [timepoints, cells]
 * layouts, always producing a Float64Array of length `shape[1]`.
 */
export function extractCellTrace(
  cellIndex: number,
  data: NpyResult,
  shape: [number, number],
  isSwapped: boolean,
): Float64Array {
  const [numCells, numTimepoints] = shape;
  const raw = new Float64Array(numTimepoints);

  if (isSwapped) {
    for (let t = 0; t < numTimepoints; t++) {
      raw[t] = Number(data.data[t * numCells + cellIndex]);
    }
  } else {
    const offset = cellIndex * numTimepoints;
    for (let t = 0; t < numTimepoints; t++) {
      raw[t] = Number(data.data[offset + t]);
    }
  }

  return raw;
}

/**
 * Transpose a 2D Fortran-order (column-major) typed array into C order (row-major).
 *
 * Uses the typed array's own constructor to preserve the element type,
 * avoiding `as any` casts via bracket-notation indexing on the base type.
 */
export function transposeFortranToC(
  data: NumericTypedArray,
  rows: number,
  cols: number,
): NumericTypedArray {
  const Constructor = data.constructor as new (length: number) => NumericTypedArray;
  const result = new Constructor(data.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const srcIdx = c * rows + r;
      const dstIdx = r * cols + c;
      result[dstIdx] = data[srcIdx];
    }
  }
  return result;
}

/**
 * Process a parsed NpyResult: handle Fortran order, then return corrected result.
 *
 * If the array is 2D and in Fortran (column-major) order, it is transposed
 * to C (row-major) order before being returned.
 */
export function processNpyResult(result: NpyResult): NpyResult {
  if (result.fortranOrder && result.shape.length === 2) {
    const [rows, cols] = result.shape;
    const transposed = transposeFortranToC(result.data, rows, cols);
    return { ...result, data: transposed, fortranOrder: false };
  }
  return result;
}
