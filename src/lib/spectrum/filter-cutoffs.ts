// Filter cutoff computation matching the Rust WASM implementation.
// Shared MARGIN_FACTOR constant kept in sync with filter.rs.

const MARGIN_FACTOR_HP = 16.0;
const MARGIN_FACTOR_LP = 4.0;

/** Compute bandpass filter cutoffs from kernel time constants. */
export function computeFilterCutoffs(
  tauRise: number,
  tauDecay: number,
): { highPass: number; lowPass: number } {
  const highPass = 1 / (2 * Math.PI * tauDecay * MARGIN_FACTOR_HP);
  const lowPass = MARGIN_FACTOR_LP / (2 * Math.PI * tauRise);
  return { highPass, lowPass };
}

