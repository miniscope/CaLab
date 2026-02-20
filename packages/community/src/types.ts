/**
 * Shared community types for the CaLab monorepo.
 * App-specific submission types extend BaseSubmission with their own fields.
 * See supabase/migrations/ for the database schema.
 */

export type DataSource = 'user' | 'demo' | 'training';

/** Common fields every CaLab app submission shares. */
export interface BaseSubmission {
  // System (auto-set by Supabase/RLS)
  id: string;
  created_at: string;
  user_id: string;

  // Required experiment metadata
  indicator: string;
  species: string;
  brain_region: string;

  // Data source & deduplication
  data_source: DataSource;
  dataset_hash: string;
  app_version: string;

  // Optional experiment metadata
  microscope_type?: string;
  imaging_depth_um?: number;
  cell_type?: string;

  // Dataset metadata
  num_cells?: number;
  recording_length_s?: number;
  fps?: number;

  // Optional metadata
  lab_name?: string;
  orcid?: string;
  virus_construct?: string;
  time_since_injection_days?: number;
  notes?: string;

  // Extensible
  extra_metadata?: Record<string, unknown>;
}

/**
 * INSERT payload for any CaLab submission table.
 * Omits id, created_at, and user_id which are auto-set by Supabase/RLS.
 */
export type BaseSubmissionPayload = Omit<BaseSubmission, 'id' | 'created_at' | 'user_id'>;

/** Shared filter state for community browsers. */
export interface BaseFilterState {
  indicator: string | null;
  species: string | null;
  brainRegion: string | null;
}

/** Result of parameter validation before submission. */
export interface SubmissionValidationResult {
  valid: boolean;
  issues: string[];
}

/** Row from the field_options lookup table. */
export interface FieldOption {
  id: number;
  field_name: 'indicator' | 'species' | 'brain_region' | 'microscope_type' | 'cell_type';
  value: string;
  display_order: number;
}

/** Grouped field options used by both SubmitPanel and FilterBar. */
export interface FieldOptions {
  indicators: string[];
  species: string[];
  brainRegions: string[];
  microscopeTypes: string[];
  cellTypes: string[];
}
