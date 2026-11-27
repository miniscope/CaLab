/** Small statistics helpers shared by the app's stores and readouts. */

/**
 * The median: the middle value, or the mean of the two middle values for an even count; null for
 * no values. `xs` is not changed (a sorted copy is used). Non-finite values are not filtered.
 * (`boundary-flags.ts` keeps its own: finite values only, NaN for none; `extract-qc.ts` its own:
 * the upper middle value.)
 */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}
