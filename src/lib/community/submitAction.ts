/**
 * Submission business logic: dataset hashing, AR2 computation,
 * payload construction, and the Supabase submit call.
 *
 * Separated from SubmitPanel UI to keep the component thin.
 */

import { computeAR2 } from '../ar2.ts';
import { computeDatasetHash } from './dataset-hash.ts';
import { submitParameters } from './community-service.ts';
import type { SubmissionPayload, CommunitySubmission } from './types.ts';

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
  tauRise: number;
  tauDecay: number;
  lambda: number;
  samplingRate: number;
  filterEnabled: boolean;
  numCells: number | undefined;
  recordingLengthS: number | undefined;
  datasetData: ArrayLike<number> | undefined;
  isDemo: boolean;
  demoPresetId: string | undefined;
  rawFileName: string | undefined;
}

/**
 * Build the full submission payload, compute derived values, and submit
 * to Supabase. Returns the created CommunitySubmission row.
 */
export async function submitToSupabase(
  fields: FormFields,
  ctx: SubmissionContext,
): Promise<CommunitySubmission> {
  // Compute dataset hash from parsed data
  let datasetHash = 'no-data';
  if (ctx.datasetData) {
    const floatData =
      ctx.datasetData instanceof Float64Array ? ctx.datasetData : new Float64Array(ctx.datasetData);
    datasetHash = await computeDatasetHash(floatData);
  }

  // Compute AR2 coefficients
  const ar2 = computeAR2(ctx.tauRise, ctx.tauDecay, ctx.samplingRate);

  // Build payload
  const payload: SubmissionPayload = {
    tau_rise: ctx.tauRise,
    tau_decay: ctx.tauDecay,
    lambda: ctx.lambda,
    sampling_rate: ctx.samplingRate,
    ar2_g1: ar2.g1,
    ar2_g2: ar2.g2,
    indicator: ctx.isDemo ? 'simulated' : fields.indicator.trim(),
    species: ctx.isDemo ? 'simulated' : fields.species.trim(),
    brain_region: ctx.isDemo ? 'simulated' : fields.brainRegion.trim(),
    lab_name: fields.labName.trim() || undefined,
    orcid: fields.orcid.trim() || undefined,
    virus_construct: ctx.isDemo ? undefined : fields.virusConstruct.trim() || undefined,
    time_since_injection_days: ctx.isDemo
      ? undefined
      : fields.timeSinceInjection
        ? parseInt(fields.timeSinceInjection, 10)
        : undefined,
    notes: fields.notes.trim() || undefined,
    microscope_type: ctx.isDemo ? undefined : fields.microscopeType.trim() || undefined,
    imaging_depth_um: ctx.isDemo
      ? undefined
      : fields.imagingDepth
        ? parseFloat(fields.imagingDepth)
        : undefined,
    cell_type: ctx.isDemo ? undefined : fields.cellType.trim() || undefined,
    num_cells: ctx.numCells,
    recording_length_s: ctx.recordingLengthS,
    fps: ctx.samplingRate,
    dataset_hash: datasetHash,
    filter_enabled: ctx.filterEnabled,
    data_source: ctx.rawFileName ? 'user' : 'demo',
    catune_version: import.meta.env.VITE_APP_VERSION || 'dev',
    extra_metadata: ctx.isDemo && ctx.demoPresetId ? { demo_preset: ctx.demoPresetId } : undefined,
  };

  return submitParameters(payload);
}
