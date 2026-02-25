/** Compute flat index into the typed array, accounting for potential dimension swap. */
export function dataIndex(
  cell: number,
  timepoint: number,
  rawCols: number,
  isSwapped: boolean,
): number {
  return isSwapped ? timepoint * rawCols + cell : cell * rawCols + timepoint;
}
