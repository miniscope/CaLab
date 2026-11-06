/** Default max firing rate (spikes/s); matches the Rust solver and Python DeconConfig. */
export const DEFAULT_MAX_FIRING_RATE = 300;
/** Largest accepted max firing rate (spikes/s); mirrors the solver's validation. */
export const MAX_FIRING_RATE_LIMIT = 10_000;

/** True for a rate the solver accepts: finite, > 0 and <= MAX_FIRING_RATE_LIMIT. */
export function isValidMaxFiringRate(v: number): boolean {
  return Number.isFinite(v) && v > 0 && v <= MAX_FIRING_RATE_LIMIT;
}

/** Help text for the Max firing rate setting. */
export const MAX_FIRING_RATE_HELP =
  'The highest rate this cell can reach during its strongest bursts — not its average firing rate. CaDecon treats it as a ceiling on how many spikes fit in one frame, but in practice the busiest frame of each trace usually reaches it, so it sets the scale of the spike counts. Set it to what this cell type realistically reaches in a burst; if unsure, err high (too high splits events into extra spikes, too low misses small events). At the default 300 spikes/s and 30 Hz imaging, up to 10 spikes fit in one frame.';
