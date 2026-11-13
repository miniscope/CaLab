// Load-time detection of rectified input traces: non-negative with at least a
// fifth of the samples exactly 0 (clipped at zero, or already denoised, e.g.
// cala's non-negative live traces or Minian/CaImAn's C). CaDecon expects raw or
// signed traces, so such input is unsupported; apps only warn about it.
//
// Same rule as the solver's `is_rectified` (crates/solver/src/indeca.rs), so the
// warning shown at load agrees with the flag the solver returns after a run.

import type { NpyResult } from '@calab/core';

/** Fraction of exact zeros that marks a trace as rectified. Equal to the
 *  solver's baseline quantile (`DEFAULT_BASELINE_QUANTILE` = 0.2): at that point
 *  the floor the rolling baseline looks for is itself exactly 0. */
export const RECTIFIED_ZERO_FRACTION = 0.2;

/**
 * Cells (ascending) whose trace is rectified: no negative finite sample and at
 * least {@link RECTIFIED_ZERO_FRACTION} of the finite samples exactly 0.
 * Non-finite samples are ignored, as in the solver.
 */
export function rectifiedCells(
  data: Pick<NpyResult, 'data' | 'shape'>,
  isSwapped: boolean,
): number[] {
  if (data.shape.length < 2) return [];
  const [rows, cols] = data.shape;
  const nCells = isSwapped ? cols : rows;
  const values = data.data;
  if (!(values instanceof Float64Array || values instanceof Float32Array)) return [];
  const finite = new Uint32Array(nCells);
  const zeros = new Uint32Array(nCells);
  const negative = new Uint8Array(nCells);
  // Row-major walk; the cell is the row (normal) or the column (swapped).
  for (let r = 0, i = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, i++) {
      const v = values[i];
      if (v - v !== 0) continue; // NaN or ±Inf
      const cell = isSwapped ? c : r;
      finite[cell]++;
      if (v < 0) negative[cell] = 1;
      else if (v === 0) zeros[cell]++;
    }
  }
  const out: number[] = [];
  for (let cell = 0; cell < nCells; cell++) {
    if (
      !negative[cell] &&
      finite[cell] > 0 &&
      zeros[cell] >= RECTIFIED_ZERO_FRACTION * finite[cell]
    ) {
      out.push(cell);
    }
  }
  return out;
}
