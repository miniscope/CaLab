/**
 * CaDecon submission: derives the kernel shape and AR2 coefficients, computes
 * aggregate run statistics, adds them to the shared payload fields
 * (buildBaseSubmissionPayload in @calab/community-ui), and submits.
 */

import { computeAR2 } from '@calab/core';
import type { DataSource } from '@calab/core';
import { tauToShape } from '@calab/compute';
import type { IndicatorId } from '@calab/compute';
import { trackEvent } from '@calab/community';
import { buildBaseSubmissionPayload, hashSubmissionDataset } from '@calab/community-ui';
import type { FormFields } from '@calab/community-ui';
import { submitParameters } from './cadecon-service.ts';
import type { CadeconSubmissionPayload, CadeconSubmission } from './types.ts';

export type { FormFields };

/** CaDecon-specific context needed to build the submission payload. */
export interface CadeconSubmissionContext {
  tauRise: number;
  tauDecay: number;
  beta: number | null;
  samplingRate: number;
  upsampleFactor: number;
  numSubsets: number;
  targetCoverage: number;
  maxIterations: number;
  convergenceTol: number;
  hpFilterEnabled: boolean;
  lpFilterEnabled: boolean;
  alphaValues: number[];
  pveValues: number[];
  perTraceResults: Record<string, { sCounts: Float32Array }>;
  durationSeconds: number | null;
  numIterations: number;
  converged: boolean;
  numCells: number | undefined;
  recordingLengthS: number | undefined;
  datasetData: ArrayLike<number> | undefined;
  dataSource: DataSource | null;
  /** Simulated indicator when dataSource is 'demo' (recorded for demo filtering). */
  demoIndicator: IndicatorId | undefined;
}

/** Compute the median of a numeric array, or null if empty. */
function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compute mean event rate: sum(sCounts > 0) / (numCells * durationSeconds). */
function computeMeanEventRate(
  perTraceResults: Record<string, { sCounts: Float32Array }>,
  durationSeconds: number | null,
): number | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  const entries = Object.values(perTraceResults);
  if (entries.length === 0) return null;

  let totalEvents = 0;
  for (const entry of entries) {
    for (let i = 0; i < entry.sCounts.length; i++) {
      if (entry.sCounts[i] > 0) totalEvents++;
    }
  }
  return totalEvents / (entries.length * durationSeconds);
}

/**
 * Build the full submission payload, compute derived values, and submit
 * to Supabase. Returns the created CadeconSubmission row.
 */
export async function submitToSupabase(
  fields: FormFields,
  ctx: CadeconSubmissionContext,
  version: string = 'dev',
): Promise<CadeconSubmission> {
  // Compute derived kernel shape (t_peak, fwhm)
  const shape = tauToShape(ctx.tauRise, ctx.tauDecay);
  if (!shape) throw new Error('Invalid tau parameters: cannot compute t_peak/fwhm');

  // Compute AR2 coefficients
  const ar2 = computeAR2(ctx.tauRise, ctx.tauDecay, ctx.samplingRate);

  // Compute aggregate statistics
  const medianAlpha = medianOrNull(ctx.alphaValues);
  const medianPve = medianOrNull(ctx.pveValues);
  const meanEventRate = computeMeanEventRate(ctx.perTraceResults, ctx.durationSeconds);

  // Build payload
  const payload: CadeconSubmissionPayload = {
    ...buildBaseSubmissionPayload(fields, {
      dataSource: ctx.dataSource,
      demoIndicator: ctx.demoIndicator,
      samplingRate: ctx.samplingRate,
      numCells: ctx.numCells,
      recordingLengthS: ctx.recordingLengthS,
      datasetHash: await hashSubmissionDataset(ctx.datasetData),
      appVersion: version,
    }),

    // Kernel results
    tau_rise: ctx.tauRise,
    tau_decay: ctx.tauDecay,
    t_peak: shape.tPeak,
    fwhm: shape.fwhm,
    beta: ctx.beta,
    ar2_g1: ar2.g1,
    ar2_g2: ar2.g2,

    // Run config
    upsample_factor: ctx.upsampleFactor,
    sampling_rate: ctx.samplingRate,
    num_subsets: ctx.numSubsets,
    target_coverage: ctx.targetCoverage,
    max_iterations: ctx.maxIterations,
    convergence_tol: ctx.convergenceTol,
    hp_filter_enabled: ctx.hpFilterEnabled,
    lp_filter_enabled: ctx.lpFilterEnabled,

    // Aggregate results
    median_alpha: medianAlpha,
    median_pve: medianPve,
    mean_event_rate: meanEventRate,
    num_iterations: ctx.numIterations,
    converged: ctx.converged,
  };

  const result = await submitParameters(payload);
  void trackEvent('submission_created', { data_source: payload.data_source });
  return result;
}
