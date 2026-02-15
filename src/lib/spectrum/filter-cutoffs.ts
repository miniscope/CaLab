// Filter cutoff computation matching the Rust WASM implementation.
// Shared MARGIN_FACTOR constant kept in sync with filter.rs.

const MARGIN_FACTOR = 4.0;

/** Compute bandpass filter cutoffs from kernel time constants. */
export function computeFilterCutoffs(
  tauRise: number,
  tauDecay: number,
): { highPass: number; lowPass: number } {
  const highPass = 1 / (2 * Math.PI * tauDecay * MARGIN_FACTOR);
  const lowPass = MARGIN_FACTOR / (2 * Math.PI * tauRise);
  return { highPass, lowPass };
}

/**
 * Compute the analytical frequency response |H(f)|² of the double-exponential kernel.
 * H(f) = 1/((1 + j2πf·τ_decay)(1 + j2πf·τ_rise))
 */
export function computeKernelFrequencyResponse(
  tauRise: number,
  tauDecay: number,
  freqs: Float64Array,
): Float64Array {
  const response = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const omega = 2 * Math.PI * freqs[i];
    const dDecay = 1 + (omega * tauDecay) ** 2;
    const dRise = 1 + (omega * tauRise) ** 2;
    response[i] = 1 / (dDecay * dRise);
  }
  return response;
}
