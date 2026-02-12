// Parameter range configuration and log-scale conversion helpers for interactive tuning.

/**
 * Scientifically reasonable parameter ranges for calcium imaging deconvolution.
 * Based on GCaMP6f/6s typical values from calcium imaging literature.
 */
export const PARAM_RANGES = {
  tauRise: {
    min: 0.001,    // 1ms -- fastest possible calcium indicator rise
    max: 0.5,      // 500ms -- very slow indicators (GCaMP6s-like)
    default: 0.02, // 20ms -- typical for GCaMP6f
    step: 0.001,   // 1ms resolution
    unit: 's',
  },
  tauDecay: {
    min: 0.05,     // 50ms -- fastest decay
    max: 3.0,      // 3s -- very slow indicators
    default: 0.4,  // 400ms -- typical for GCaMP6f
    step: 0.01,    // 10ms resolution
    unit: 's',
  },
  lambda: {
    min: 0,        // No sparsity penalty
    max: 4.0,      // High sparsity (only largest events)
    default: 0.01, // Moderate sparsity
    logScale: false,
  },
} as const;

// --- Log-scale conversion for lambda slider ---

const LOG_LAMBDA_MIN = Math.log10(PARAM_RANGES.lambda.min); // -4
const LOG_LAMBDA_MAX = Math.log10(PARAM_RANGES.lambda.max); // 1

/**
 * Convert a linear slider position [0, 1] to a logarithmic lambda value.
 * Maps uniformly across orders of magnitude: 0 -> 0.0001, 0.5 -> ~0.01, 1 -> 10.
 */
export function sliderToLambda(position: number): number {
  return Math.pow(10, LOG_LAMBDA_MIN + position * (LOG_LAMBDA_MAX - LOG_LAMBDA_MIN));
}

/**
 * Convert a lambda value to a linear slider position [0, 1].
 * Inverse of sliderToLambda.
 */
export function lambdaToSlider(lambda: number): number {
  return (Math.log10(lambda) - LOG_LAMBDA_MIN) / (LOG_LAMBDA_MAX - LOG_LAMBDA_MIN);
}
