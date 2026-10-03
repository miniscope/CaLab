/**
 * CaTune submission: converts the tuned kernel shape to tau values, computes
 * AR2 coefficients, adds them to the shared payload fields
 * (buildBaseSubmissionPayload in @calab/community-ui), and submits.
 *
 * Separated from SubmitPanel UI to keep the component thin.
 */

import { computeAR2 } from '@calab/core';
import type { DataSource } from '@calab/core';
import { shapeToTau } from '@calab/compute';
import type { IndicatorId } from '@calab/compute';
import { trackEvent } from '@calab/community';
import { buildBaseSubmissionPayload, hashSubmissionDataset } from '@calab/community-ui';
import type { FormFields } from '@calab/community-ui';
import { submitParameters } from './catune-service.ts';
import type { CatuneSubmissionPayload, CatuneSubmission } from './types.ts';

export type { FormFields };

/** Tuning/dataset context needed to build the submission payload. */
export interface SubmissionContext {
  tPeak: number;
  fwhm: number;
  lambda: number;
  samplingRate: number;
  filterEnabled: boolean;
  numCells: number | undefined;
  recordingLengthS: number | undefined;
  datasetData: ArrayLike<number> | undefined;
  dataSource: DataSource | null;
  /** Simulated indicator when dataSource is 'demo' (recorded for demo filtering). */
  demoIndicator: IndicatorId | undefined;
  rawFileName: string | undefined;
}

/**
 * Build the full submission payload, compute derived values, and submit
 * to Supabase. Returns the created CatuneSubmission row.
 */
export async function submitToSupabase(
  fields: FormFields,
  ctx: SubmissionContext,
  version: string = 'dev',
): Promise<CatuneSubmission> {
  // Convert shape params (tPeak, fwhm) to tau params for AR2 and storage
  const tauResult = shapeToTau(ctx.tPeak, ctx.fwhm);
  if (!tauResult) {
    throw new Error('Invalid kernel shape: could not convert tPeak/fwhm to tau values');
  }
  const { tauRise, tauDecay } = tauResult;
  const ar2 = computeAR2(tauRise, tauDecay, ctx.samplingRate);

  const payload: CatuneSubmissionPayload = {
    ...buildBaseSubmissionPayload(fields, {
      dataSource: ctx.dataSource,
      demoIndicator: ctx.demoIndicator,
      samplingRate: ctx.samplingRate,
      numCells: ctx.numCells,
      recordingLengthS: ctx.recordingLengthS,
      datasetHash: await hashSubmissionDataset(ctx.datasetData),
      appVersion: version,
    }),
    tau_rise: tauRise,
    tau_decay: tauDecay,
    t_peak: ctx.tPeak,
    fwhm: ctx.fwhm,
    lambda: ctx.lambda,
    sampling_rate: ctx.samplingRate,
    ar2_g1: ar2.g1,
    ar2_g2: ar2.g2,
    filter_enabled: ctx.filterEnabled,
  };

  const result = await submitParameters(payload);
  void trackEvent('submission_created', { data_source: payload.data_source });
  return result;
}
