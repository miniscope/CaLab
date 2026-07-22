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
 * Convergence is tested with the peak-normalized RMSE between successive
 * iterations' bi-exponential kernels (a fraction of peak, → 0 at convergence),
 * rather than a relative change of (tau_rise, tau_decay) or (peak time, FWHM):
 * the waveform RMSE weights each parameter's change by how much it actually moves
 * the kernel, so a jittery t_peak on the poorly-constrained rising edge no longer
 * delays convergence over a change that barely alters the shape.
 */
export const CONVERGENCE_RANGES = {
  /**
   * Peak-normalized kernel RMSE below which an iteration counts as "stable",
   * as a fraction of peak (0.005 ≈ 0.5%-of-peak typical deviation ≈ a ~2% change
   * in tau).
   */
  convergenceTol: {
    min: 0.001,
    max: 0.05,
    default: 0.005,
    step: 0.001,
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
