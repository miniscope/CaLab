/**
 * Community submission types for CaTune parameter sharing.
 * See supabase/migrations/ for the database schema.
 */

export type DataSource = 'user' | 'demo' | 'training';

/** Full community submission row as returned from the database. */
export interface CommunitySubmission {
  id: string;
  created_at: string;
  user_id: string;

  // Core parameters
  tau_rise: number;
  tau_decay: number;
  lambda: number;
  sampling_rate: number;

  // AR2 coefficients
  ar2_g1: number;
  ar2_g2: number;

  // Required metadata
  indicator: string;
  species: string;
  brain_region: string;

  // Preprocessing
  filter_enabled?: boolean;

  // Optional metadata
  lab_name?: string;
  orcid?: string;
  virus_construct?: string;
  time_since_injection_days?: number;
  notes?: string;

  // Dataset metadata
  num_cells?: number;
  recording_length_s?: number;
  fps?: number;

  // Deduplication
  dataset_hash: string;
  catune_version: string;

  // Data source
  data_source: DataSource;

  // Optional experiment metadata
  microscope_type?: string;
  imaging_depth_um?: number;
  cell_type?: string;

  // Extensible
  extra_metadata?: Record<string, unknown>;
}

/**
 * INSERT payload for community_submissions.
 * Omits id, created_at, and user_id which are auto-set by Supabase/RLS.
 */
export type SubmissionPayload = Omit<CommunitySubmission, 'id' | 'created_at' | 'user_id'>;

/** User-entered metadata fields from the submission form. */
export interface SubmissionMetadata {
  // Required
  indicator: string;
  species: string;
  brainRegion: string;

  // Optional
  labName?: string;
  orcid?: string;
  virusConstruct?: string;
  timeSinceInjectionDays?: number;
  notes?: string;
}

/** Filter state for the community browser. */
export interface FilterState {
  indicator: string | null;
  species: string | null;
  brainRegion: string | null;
  demoPreset: string | null;
}

/** Result of parameter validation before submission. */
export interface ValidationResult {
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
