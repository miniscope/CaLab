/**
 * Rectified-input warning. The solver flags a cell whose input trace is
 * non-negative with at least a fifth of its samples exactly 0 (clipped at
 * zero, or already denoised). CaDecon expects raw or signed traces, so such
 * input is unsupported; the flag only warns and never changes a result.
 */

export interface RectifiedFlag {
  cellIndex: number;
  rectifiedInput?: boolean;
}

/** Sorted unique indices of the cells the solver flagged as rectified input. */
export function rectifiedCellIndices(entries: Iterable<RectifiedFlag>): number[] {
  const set = new Set<number>();
  for (const e of entries) {
    if (e.rectifiedInput) set.add(e.cellIndex);
  }
  return [...set].sort((a, b) => a - b);
}

/** What to do about it (shared by the dataset banner and the per-cell note). */
export const RECTIFIED_INPUT_FIX =
  'CaDecon expects raw or signed traces: in cala, run Extract and export for CaDecon (signed traces); from Minian/CaImAn, use C + YrA, not C.';

/** Dataset-level banner text for `n` flagged cells (empty when none). */
export function rectifiedBannerText(n: number): string {
  if (n <= 0) return '';
  const cells = n === 1 ? '1 cell looks' : `${n} cells look`;
  return `${cells} clipped at zero or already denoised (non-negative with many exact zeros). ${RECTIFIED_INPUT_FIX}`;
}

/** Sorted union of cell-index lists (load-time scan and solver flags). */
export function mergeCellIndices(...lists: readonly number[][]): number[] {
  const set = new Set<number>();
  for (const list of lists) for (const c of list) set.add(c);
  return [...set].sort((a, b) => a - b);
}
