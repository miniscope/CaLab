// Parameter validation and quality scoring for community submissions.
// Hard limits block submission (validateSubmission).
// Soft scoring provides informational quality (computeQualityScore).

import type { QualityCheckResult } from './types.ts';

/** Hard parameter range limits that block submission if violated. */
const HARD_LIMITS = {
  tauRise: { min: 0.001, max: 0.5, label: 'tau_rise' },
  tauDecay: { min: 0.01, max: 10, label: 'tau_decay' },
  lambda: { min: 1e-6, max: 1.0, label: 'lambda' },
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
 * Also includes a soft quality score.
 */
export function validateSubmission(
  params: ValidationParams & {
    numCells?: number;
    recordingLengthS?: number;
  },
): QualityCheckResult {
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
  if (params.samplingRate < HARD_LIMITS.samplingRate.min || params.samplingRate > HARD_LIMITS.samplingRate.max) {
    issues.push(
      `sampling_rate (${params.samplingRate} Hz) is outside the valid range [${HARD_LIMITS.samplingRate.min}, ${HARD_LIMITS.samplingRate.max}] Hz`,
    );
  }

  // tau_rise must be less than tau_decay
  if (params.tauRise >= params.tauDecay) {
    issues.push(
      `tau_rise (${params.tauRise}s) must be less than tau_decay (${params.tauDecay}s)`,
    );
  }

  const score = computeQualityScore(params);

  return {
    valid: issues.length === 0,
    score,
    issues,
  };
}

/**
 * Compute a soft quality score from 0.0 to 1.0.
 * Does not block submission -- provides informational quality assessment.
 * Penalizes unusual parameter ranges and rewards larger datasets.
 */
export function computeQualityScore(params: {
  tauRise: number;
  tauDecay: number;
  lambda?: number;
  samplingRate?: number;
  numCells?: number;
  recordingLengthS?: number;
}): number {
  let score = 1.0;

  // Penalize unusual tau_rise (typical: 5-100ms)
  if (params.tauRise < 0.005 || params.tauRise > 0.1) {
    score *= 0.7;
  }

  // Penalize unusual tau_decay (typical: 100ms - 2s)
  if (params.tauDecay < 0.1 || params.tauDecay > 2.0) {
    score *= 0.7;
  }

  // Penalize if tau_rise >= tau_decay (physically implausible)
  if (params.tauRise >= params.tauDecay) {
    score *= 0.3;
  }

  // Bonus for adequate dataset size
  if (params.numCells != null && params.numCells >= 10) {
    score *= 1.1;
  }

  // Bonus for long recording
  if (params.recordingLengthS != null && params.recordingLengthS >= 60) {
    score *= 1.1;
  }

  // Clamp to [0.0, 1.0]
  return Math.min(1.0, Math.max(0.0, score));
}
