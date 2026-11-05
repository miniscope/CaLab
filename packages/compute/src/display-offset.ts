/**
 * Display offset for the solver's working trace.
 *
 * The solver operates on a baseline-subtracted (and optionally band-passed)
 * working trace that sits near 0, while the Raw trace is drawn in the data's own
 * units (e.g. F0 ~ 500 for raw fluorescence). Drawn against a y-range that follows
 * the raw data, the working trace and fit fall off-screen. The display offset is
 * the constant that moves working-trace-domain series back onto the Raw scale:
 * the median of (raw - working), robust to transients. Display only: never feed
 * offset series back into the solver, and compute residuals before adding it.
 */
export function computeDisplayOffset(
  raw: ArrayLike<number>,
  working: ArrayLike<number> | null | undefined,
): number {
  if (!working) return 0;
  const n = Math.min(raw.length, working.length);
  if (n === 0) return 0;
  const d = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = raw[i] - working[i];
    if (Number.isFinite(v)) d[m++] = v;
  }
  if (m === 0) return 0;
  const s = d.subarray(0, m).sort();
  return m % 2 === 1 ? s[(m - 1) >> 1] : 0.5 * (s[m / 2 - 1] + s[m / 2]);
}
