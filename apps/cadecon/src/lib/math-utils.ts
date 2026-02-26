// Small pure-math utilities used across CaDecon components and managers.

/** Compute the median of a numeric array. Returns 0 for empty arrays. */
export function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Compute the interquartile range [Q1, Q3]. Returns [0, 0] for empty arrays. */
export function iqr(arr: number[]): [number, number] {
  if (arr.length === 0) return [0, 0];
  const sorted = [...arr].sort((a, b) => a - b);
  const q1Idx = Math.floor(sorted.length * 0.25);
  const q3Idx = Math.floor(sorted.length * 0.75);
  return [sorted[q1Idx], sorted[q3Idx]];
}
