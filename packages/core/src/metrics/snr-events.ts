/**
 * Types for the event detector and silent flag in the WASM `snr` bindings
 * (`snr_detect_events`, `snr_measured_report`; Rust source
 * `crates/solver/src/snr.rs`). The wasm-bindgen output types both as `any`.
 */

/** A calcium event found by `snr_detect_events`. */
export interface SnrEvent {
  /** Sample index of the event's peak in the lightly smoothed trace. */
  time_index: number;
  /** Peak height above the local pre-event baseline, in trace units. */
  height: number;
  /** The local pre-event baseline the height is measured from. */
  baseline: number;
}

/**
 * Result of `snr_measured_report(trace, minSeparationSamples)`.
 *
 * `snr` is the top-slice measured SNR (mean of the top 1 % of samples minus
 * the median, over the MAD-of-differences noise σ). Pure noise measures about
 * 2.7, so values near that mean "indistinguishable from noise". `is_silent`
 * is the explicit answer: true when no event clears the noise-derived floor.
 */
export interface SnrReport {
  snr: number;
  sigma: number;
  n_events: number;
  is_silent: boolean;
}
