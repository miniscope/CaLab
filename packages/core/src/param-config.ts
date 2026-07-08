// Parameter range configuration and log-scale conversion helpers for interactive tuning.

/**
 * Scientifically reasonable parameter ranges for calcium imaging deconvolution.
 * Based on GCaMP6f/6s typical values from calcium imaging literature.
 */
export const PARAM_RANGES = {
  tPeak: {
    min: 0.005, // 5ms -- fastest plausible time-to-peak
    max: 0.5, // 500ms -- very slow indicators
    default: 0.008, // ≈ tauToShape(0.001, 3.0).tPeak
    step: 0.001, // 1ms resolution
    unit: 's',
  },
  fwhm: {
    min: 0.02, // 20ms -- narrowest plausible transient
    max: 3.0, // 3s -- very slow indicators
    default: 2.08, // ≈ tauToShape(0.001, 3.0).fwhm
    step: 0.001, // 1ms resolution
    unit: 's',
  },
  lambda: {
    min: 0, // No sparsity penalty
    max: 10, // High sparsity (only largest events)
    default: 0, // start at minimum sparsity
    logScale: false,
  },
} as const;

/**
 * CaDecon iterative-loop convergence parameters.
 *
 * Convergence is tested in kernel SHAPE space (peak time + FWHM) rather than in
 * (tau_rise, tau_decay): the tau pair is degenerate (tau_rise <-> tau_decay
 * thrash inflates the delta), so a shape-space tolerance settles meaningfully.
 */
export const CONVERGENCE_RANGES = {
  /** Relative change of peak time AND FWHM below which an iteration counts as "stable". */
  convergenceTol: {
    min: 0.005,
    max: 0.1,
    default: 0.02,
    step: 0.005,
  },
  /** Consecutive stable iterations required before declaring convergence. */
  convergencePatience: {
    min: 1,
    max: 10,
    default: 3,
    step: 1,
  },
  /** Minimum iterations before convergence is eligible (keeps the seed from trivially "converging"). */
  convergenceMinIters: {
    min: 0,
    max: 10,
    default: 2,
    step: 1,
  },
  /** Number of trailing iterates whose shapes are median-combined into the final kernel. */
  finalSelectionWindow: {
    min: 1,
    max: 20,
    default: 5,
    step: 1,
  },
} as const;
