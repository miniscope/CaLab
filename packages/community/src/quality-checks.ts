// Parameter validation for community submissions.
// Hard limits block submission (validateSubmission).

import type { SubmissionValidationResult } from './types.ts';

/** Hard parameter range limits that block submission if violated. */
const HARD_LIMITS = {
  tauRise: { min: 0.001, max: 0.5, label: 'tau_rise' },
  tauDecay: { min: 0.01, max: 10, label: 'tau_decay' },
  lambda: { min: 1e-6, max: 10, label: 'lambda' },
  samplingRate: { min: 1, max: 1000, label: 'sampling_rate' },
} as const;

interface ValidationParams {
  tauRise: number;
  tauDecay: number;
  lambda: number;
  samplingRate: number;
}

/**
 * Validate parameters against hard limits.
 * Returns valid=false with human-readable issues if any check fails.
 */
export function validateSubmission(params: ValidationParams): SubmissionValidationResult {
  const issues: string[] = [];

  // tau_rise range check
  if (params.tauRise < HARD_LIMITS.tauRise.min || params.tauRise > HARD_LIMITS.tauRise.max) {
    issues.push(
      `tau_rise (${params.tauRise}s) is outside the valid range [${HARD_LIMITS.tauRise.min}s, ${HARD_LIMITS.tauRise.max}s]`,
    );
  }

  // tau_decay range check
  if (params.tauDecay < HARD_LIMITS.tauDecay.min || params.tauDecay > HARD_LIMITS.tauDecay.max) {
    issues.push(
      `tau_decay (${params.tauDecay}s) is outside the valid range [${HARD_LIMITS.tauDecay.min}s, ${HARD_LIMITS.tauDecay.max}s]`,
    );
  }

  // lambda range check
  if (params.lambda < HARD_LIMITS.lambda.min || params.lambda > HARD_LIMITS.lambda.max) {
    issues.push(
      `lambda (${params.lambda}) is outside the valid range [${HARD_LIMITS.lambda.min}, ${HARD_LIMITS.lambda.max}]`,
    );
  }

  // sampling_rate range check
  if (
    params.samplingRate < HARD_LIMITS.samplingRate.min ||
    params.samplingRate > HARD_LIMITS.samplingRate.max
  ) {
    issues.push(
      `sampling_rate (${params.samplingRate} Hz) is outside the valid range [${HARD_LIMITS.samplingRate.min}, ${HARD_LIMITS.samplingRate.max}] Hz`,
    );
  }

  // tau_rise must be less than tau_decay
  if (params.tauRise >= params.tauDecay) {
    issues.push(`tau_rise (${params.tauRise}s) must be less than tau_decay (${params.tauDecay}s)`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
