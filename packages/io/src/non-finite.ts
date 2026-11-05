// Per-cell non-finite (NaN / ±Inf) sample counts.
//
// The Rust solver rejects any trace with a non-finite sample, on purpose. The
// apps therefore scan the dataset once at load, keep the per-cell counts, and
// skip those cells (shown as "skipped") instead of letting their solves fail.
// This is the one place that scan lives; app code asks it, never re-loops
// with isFinite.

import type { NpyResult } from '@calab/core';

/** Machine-readable reason a cell was not solved (results export `skipped_reason`). */
export const NON_FINITE_SKIP_REASON = 'non_finite_samples';

/**
 * Count non-finite samples in every cell of a C-order 2D trace matrix.
 * One pass over the flat array. `isSwapped` means the stored array is
 * [timepoints, cells]. Integer arrays cannot hold NaN/Inf and return zeros.
 */
export function countNonFinitePerCell(
  data: Pick<NpyResult, 'data' | 'shape'>,
  isSwapped: boolean,
): Uint32Array {
  if (data.shape.length < 2) return new Uint32Array(0);
  const [rows, cols] = data.shape;
  const nCells = isSwapped ? cols : rows;
  const counts = new Uint32Array(nCells);
  const values = data.data;
  if (!(values instanceof Float64Array || values instanceof Float32Array)) return counts;
  // Row-major walk; the cell is the row (normal) or the column (swapped).
  // v - v is NaN for NaN and ±Inf and 0 otherwise, so one test covers both.
  for (let r = 0, i = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, i++) {
      const v = values[i];
      if (v - v !== 0) counts[isSwapped ? c : r]++;
    }
  }
  return counts;
}

/** Cells (ascending) with at least one non-finite sample. */
export function cellsWithNonFinite(counts: ArrayLike<number> | null | undefined): number[] {
  const out: number[] = [];
  if (!counts) return out;
  for (let c = 0; c < counts.length; c++) if (counts[c] > 0) out.push(c);
  return out;
}

/** True when `cell` has a non-finite sample and the solver must skip it. */
export function isNonFiniteCell(
  counts: ArrayLike<number> | null | undefined,
  cell: number,
): boolean {
  return !!counts && (counts[cell] ?? 0) > 0;
}

/** `ids` without the cells that have non-finite samples (order kept). */
export function withoutNonFinite(
  ids: readonly number[],
  counts: ArrayLike<number> | null | undefined,
): number[] {
  return counts ? ids.filter((c) => !isNonFiniteCell(counts, c)) : [...ids];
}

/** User-facing note for a skipped cell. */
export function nonFiniteSkipMessage(count: number): string {
  return `Skipped: trace contains ${count} missing (NaN/Inf) sample${count === 1 ? '' : 's'}`;
}
