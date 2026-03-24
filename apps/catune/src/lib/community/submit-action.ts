/**
 * Submission business logic: dataset hashing, AR2 computation,
 * payload construction, and the Supabase submit call.
 *
 * Separated from SubmitPanel UI to keep the component thin.
 */

import { computeAR2 } from '@calab/core';
import { shapeToTau } from '@calab/compute';
import { computeDatasetHash, trackEvent } from '@calab/community';
import { submitParameters } from './catune-service.ts';
import type { CatuneSubmissionPayload, CatuneSubmission } from './types.ts';
import type { DataSource as CommunityDataSource } from '@calab/community';
import type { DataSource as AppDataSource } from '../../lib/data-store.ts';

/** Form field values collected from the submission form. */
export interface FormFields {
  indicator: string;
  species: string;
  brainRegion: string;
  labName: string;
  orcid: string;
  virusConstruct: string;
  timeSinceInjection: string;
  notes: string;
  microscopeType: string;
  cellType: string;
  imagingDepth: string;
}

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
  dataSource: AppDataSource;
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
  // Compute dataset hash from parsed data
  let datasetHash = 'no-data';
  if (ctx.datasetData) {
    const floatData =
      ctx.datasetData instanceof Float64Array ? ctx.datasetData : new Float64Array(ctx.datasetData);
    datasetHash = await computeDatasetHash(floatData);
  }

  // Convert shape params (tPeak, fwhm) to tau params for AR2 and storage
  const tauResult = shapeToTau(ctx.tPeak, ctx.fwhm);
  if (!tauResult) {
    throw new Error('Invalid kernel shape: could not convert tPeak/fwhm to tau values');
  }
  const { tauRise, tauDecay } = tauResult;

  // Compute AR2 coefficients
  const ar2 = computeAR2(tauRise, tauDecay, ctx.samplingRate);

  // Map app-level DataSource to community DataSource for storage
  const isDemo = ctx.dataSource === 'demo';
  const communitySource: CommunityDataSource =
    ctx.dataSource === 'demo' ? 'demo' : ctx.dataSource === 'bridge' ? 'bridge' : 'user';

  // Build payload
  const payload: CatuneSubmissionPayload = {
    tau_rise: tauRise,
    tau_decay: tauDecay,
    t_peak: ctx.tPeak,
    fwhm: ctx.fwhm,
    lambda: ctx.lambda,
    sampling_rate: ctx.samplingRate,
    ar2_g1: ar2.g1,
    ar2_g2: ar2.g2,
    indicator: isDemo ? 'simulated' : fields.indicator.trim(),
    species: isDemo ? 'simulated' : fields.species.trim(),
    brain_region: isDemo ? 'simulated' : fields.brainRegion.trim(),
    lab_name: fields.labName.trim() || undefined,
    orcid: fields.orcid.trim() || undefined,
    virus_construct: isDemo ? undefined : fields.virusConstruct.trim() || undefined,
    time_since_injection_days: isDemo
      ? undefined
      : fields.timeSinceInjection
        ? parseInt(fields.timeSinceInjection, 10)
        : undefined,
    notes: fields.notes.trim() || undefined,
    microscope_type: isDemo ? undefined : fields.microscopeType.trim() || undefined,
    imaging_depth_um: isDemo
      ? undefined
      : fields.imagingDepth
        ? parseFloat(fields.imagingDepth)
        : undefined,
    cell_type: isDemo ? undefined : fields.cellType.trim() || undefined,
    num_cells: ctx.numCells,
    recording_length_s: ctx.recordingLengthS,
    fps: ctx.samplingRate,
    dataset_hash: datasetHash,
    filter_enabled: ctx.filterEnabled,
    data_source: communitySource,
    app_version: version,
    extra_metadata: undefined,
  };

  const result = await submitParameters(payload);
  void trackEvent('submission_created', { data_source: payload.data_source });
  return result;
}
