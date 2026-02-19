// Parameter range configuration and log-scale conversion helpers for interactive tuning.

/**
 * Scientifically reasonable parameter ranges for calcium imaging deconvolution.
 * Based on GCaMP6f/6s typical values from calcium imaging literature.
 */
export const PARAM_RANGES = {
  tauRise: {
    min: 0.001, // 1ms -- fastest possible calcium indicator rise
    max: 0.5, // 500ms -- very slow indicators (GCaMP6s-like)
    default: 0.001, // start at minimum
    step: 0.001, // 1ms resolution
    unit: 's',
  },
  tauDecay: {
    min: 0.05, // 50ms -- fastest decay
    max: 3.0, // 3s -- very slow indicators
    default: 3.0, // start at maximum (longer than any indicator)
    step: 0.01, // 10ms resolution
    unit: 's',
  },
  lambda: {
    min: 0, // No sparsity penalty
    max: 10, // High sparsity (only largest events)
    default: 0, // start at minimum sparsity
    logScale: false,
  },
} as const;
