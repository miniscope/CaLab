/**
 * App-neutral pieces of a community submission payload: the experiment
 * metadata from the submit form, dataset fingerprint, data-source mapping,
 * and demo-preset tagging. Each app's `submit-action.ts` adds its own
 * algorithm fields (kernel params, run config, ...) on top.
 */

import type { DataSource } from '@calab/core';
import type { IndicatorId } from '@calab/compute';
import type { BaseSubmission, DataSource as CommunityDataSource } from '@calab/community';
import { computeDatasetHash, demoPresetMetadata } from '@calab/community';

/** INSERT fields every submission table shares (id/created_at/user_id are set by Supabase). */
export type BaseSubmissionPayload = Omit<BaseSubmission, 'id' | 'created_at' | 'user_id'>;

/** Values collected by the community submit form (all strings, as typed). */
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

/**
 * Map the app-side data source to the vocabulary stored in the submission
 * tables. 'file' becomes 'user'; nothing loaded yet also counts as 'user',
 * matching what both apps sent before this mapping existed. The community
 * value 'training' is never produced by the apps.
 */
export function toCommunityDataSource(source: DataSource | null): CommunityDataSource {
  switch (source) {
    case 'demo':
      return 'demo';
    case 'bridge':
      return 'bridge';
    case 'file':
    case null:
      return 'user';
  }
}

/**
 * Parse an optional numeric form field: undefined when empty or not a number
 * (so a stray "abc" is dropped rather than stored as NaN).
 */
export function parseOptionalNumber(
  value: string,
  parser: (s: string) => number = parseFloat,
): number | undefined {
  if (!value) return undefined;
  const n = parser(value);
  return Number.isNaN(n) ? undefined : n;
}

/** SHA-256 fingerprint of the trace data for duplicate detection ('no-data' when absent). */
export async function hashSubmissionDataset(data: ArrayLike<number> | undefined): Promise<string> {
  if (!data) return 'no-data';
  const floatData = data instanceof Float64Array ? data : new Float64Array(data);
  return computeDatasetHash(floatData);
}

/** Dataset context shared by every app's submission. */
export interface BaseSubmissionContext {
  dataSource: DataSource | null;
  /** Simulated indicator when dataSource is 'demo' (recorded for demo filtering). */
  demoIndicator: IndicatorId | undefined;
  samplingRate: number;
  numCells: number | undefined;
  recordingLengthS: number | undefined;
  datasetHash: string;
  appVersion: string;
}

/**
 * Build the BaseSubmissionPayload fields from the form and dataset context.
 * Demo submissions record 'simulated' for the required metadata and drop the
 * experiment-only optional fields.
 */
export function buildBaseSubmissionPayload(
  fields: FormFields,
  ctx: BaseSubmissionContext,
): BaseSubmissionPayload {
  const isDemo = ctx.dataSource === 'demo';
  return {
    indicator: isDemo ? 'simulated' : fields.indicator.trim(),
    species: isDemo ? 'simulated' : fields.species.trim(),
    brain_region: isDemo ? 'simulated' : fields.brainRegion.trim(),
    lab_name: fields.labName.trim() || undefined,
    orcid: fields.orcid.trim() || undefined,
    virus_construct: isDemo ? undefined : fields.virusConstruct.trim() || undefined,
    time_since_injection_days: isDemo
      ? undefined
      : parseOptionalNumber(fields.timeSinceInjection, (s) => parseInt(s, 10)),
    notes: fields.notes.trim() || undefined,
    microscope_type: isDemo ? undefined : fields.microscopeType.trim() || undefined,
    imaging_depth_um: isDemo ? undefined : parseOptionalNumber(fields.imagingDepth, parseFloat),
    cell_type: isDemo ? undefined : fields.cellType.trim() || undefined,
    num_cells: ctx.numCells,
    recording_length_s: ctx.recordingLengthS,
    fps: ctx.samplingRate,
    dataset_hash: ctx.datasetHash,
    data_source: toCommunityDataSource(ctx.dataSource),
    app_version: ctx.appVersion,
    extra_metadata: isDemo && ctx.demoIndicator ? demoPresetMetadata(ctx.demoIndicator) : undefined,
  };
}
