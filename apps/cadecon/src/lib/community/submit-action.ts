/**
 * CaDecon submission business logic: dataset hashing, AR2 computation,
 * aggregate statistic computation, payload construction, and Supabase submit.
 */

import { computeAR2 } from '@calab/core';
import { computeDatasetHash, trackEvent } from '@calab/community';
import { submitParameters } from './cadecon-service.ts';
import type { CadeconSubmissionPayload, CadeconSubmission } from './types.ts';
import type { DataSource as CommunityDataSource } from '@calab/community';
import type { DataSource as AppDataSource } from '../data-store.ts';

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
  weightingEnabled: boolean;
  hpFilterEnabled: boolean;
  lpFilterEnabled: boolean;
  alphaValues: number[];
  pveValues: number[];
  perTraceResults: Record<number, { sCounts: Float32Array }>;
  durationSeconds: number | null;
  numIterations: number;
  converged: boolean;
  numCells: number | undefined;
  recordingLengthS: number | undefined;
  datasetData: ArrayLike<number> | undefined;
  dataSource: AppDataSource;
  demoPresetId: string | undefined;
}

/** Compute the median of a numeric array. Returns null for empty arrays. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compute mean event rate: sum(sCounts > 0) / (numCells * durationSeconds). */
function computeMeanEventRate(
  perTraceResults: Record<number, { sCounts: Float32Array }>,
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
  // Compute dataset hash from parsed data
  let datasetHash = 'no-data';
  if (ctx.datasetData) {
    const floatData =
      ctx.datasetData instanceof Float64Array ? ctx.datasetData : new Float64Array(ctx.datasetData);
    datasetHash = await computeDatasetHash(floatData);
  }

  // Compute AR2 coefficients
  const ar2 = computeAR2(ctx.tauRise, ctx.tauDecay, ctx.samplingRate);

  // Map app-level DataSource to community DataSource
  const isDemo = ctx.dataSource === 'demo';
  const communitySource: CommunityDataSource =
    ctx.dataSource === 'demo' ? 'demo' : ctx.dataSource === 'bridge' ? 'bridge' : 'user';

  // Compute aggregate statistics
  const medianAlpha = median(ctx.alphaValues);
  const medianPve = median(ctx.pveValues);
  const meanEventRate = computeMeanEventRate(ctx.perTraceResults, ctx.durationSeconds);

  // Build payload
  const payload: CadeconSubmissionPayload = {
    // Kernel results
    tau_rise: ctx.tauRise,
    tau_decay: ctx.tauDecay,
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
    weighting_enabled: ctx.weightingEnabled,
    hp_filter_enabled: ctx.hpFilterEnabled,
    lp_filter_enabled: ctx.lpFilterEnabled,

    // Aggregate results
    median_alpha: medianAlpha,
    median_pve: medianPve,
    mean_event_rate: meanEventRate,
    num_iterations: ctx.numIterations,
    converged: ctx.converged,

    // Required metadata
    indicator: isDemo ? 'simulated' : fields.indicator.trim(),
    species: isDemo ? 'simulated' : fields.species.trim(),
    brain_region: isDemo ? 'simulated' : fields.brainRegion.trim(),

    // Optional metadata
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

    // Dataset metadata
    num_cells: ctx.numCells,
    recording_length_s: ctx.recordingLengthS,
    fps: ctx.samplingRate,

    // Deduplication & versioning
    dataset_hash: datasetHash,
    data_source: communitySource,
    app_version: version,
    extra_metadata: isDemo && ctx.demoPresetId ? { demo_preset: ctx.demoPresetId } : undefined,
  };

  const result = await submitParameters(payload);
  void trackEvent('submission_created', { data_source: payload.data_source });
  return result;
}
