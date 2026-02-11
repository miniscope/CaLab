/**
 * Community submission types for CaTune parameter sharing.
 *
 * SQL migration for community_submissions table:
 * Run this in Supabase Dashboard -> SQL Editor to create the table.
 *
 * ```sql
 * CREATE TABLE community_submissions (
 *   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *   created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
 *   user_id UUID REFERENCES auth.users(id) NOT NULL,
 *
 *   -- Core parameters (always present, queryable)
 *   tau_rise DOUBLE PRECISION NOT NULL,
 *   tau_decay DOUBLE PRECISION NOT NULL,
 *   lambda DOUBLE PRECISION NOT NULL,
 *   sampling_rate DOUBLE PRECISION NOT NULL,
 *
 *   -- AR2 coefficients (auto-computed)
 *   ar2_g1 DOUBLE PRECISION NOT NULL,
 *   ar2_g2 DOUBLE PRECISION NOT NULL,
 *
 *   -- Required metadata (flat, filterable)
 *   indicator TEXT NOT NULL,
 *   species TEXT NOT NULL,
 *   brain_region TEXT NOT NULL,
 *
 *   -- Optional metadata
 *   lab_name TEXT,
 *   orcid TEXT,
 *   virus_construct TEXT,
 *   time_since_injection_days INTEGER,
 *   notes TEXT,
 *
 *   -- Dataset metadata
 *   num_cells INTEGER,
 *   recording_length_s DOUBLE PRECISION,
 *   fps DOUBLE PRECISION,
 *
 *   -- Quality & deduplication
 *   dataset_hash TEXT NOT NULL,
 *   quality_score DOUBLE PRECISION,
 *   catune_version TEXT NOT NULL,
 *
 *   -- Extensible metadata
 *   extra_metadata JSONB DEFAULT '{}'::jsonb,
 *
 *   -- Constraints
 *   CONSTRAINT valid_tau_rise CHECK (tau_rise > 0 AND tau_rise < 1),
 *   CONSTRAINT valid_tau_decay CHECK (tau_decay > 0 AND tau_decay < 10),
 *   CONSTRAINT valid_lambda CHECK (lambda > 0 AND lambda < 1),
 *   CONSTRAINT valid_sampling_rate CHECK (sampling_rate > 0 AND sampling_rate <= 1000)
 * );
 *
 * -- Enable RLS
 * ALTER TABLE community_submissions ENABLE ROW LEVEL SECURITY;
 *
 * -- Anyone can read submissions (community browsing)
 * CREATE POLICY "Public read access"
 * ON community_submissions FOR SELECT
 * TO anon, authenticated
 * USING (true);
 *
 * -- Only authenticated users can insert
 * CREATE POLICY "Authenticated users can submit"
 * ON community_submissions FOR INSERT
 * TO authenticated
 * WITH CHECK ((select auth.uid()) = user_id);
 *
 * -- Users can only delete their own submissions
 * CREATE POLICY "Users can delete own submissions"
 * ON community_submissions FOR DELETE
 * TO authenticated
 * USING ((select auth.uid()) = user_id);
 *
 * -- Performance indexes
 * CREATE INDEX idx_submissions_user_id ON community_submissions USING btree (user_id);
 * CREATE INDEX idx_submissions_indicator ON community_submissions (indicator);
 * CREATE INDEX idx_submissions_species ON community_submissions (species);
 * CREATE INDEX idx_submissions_brain_region ON community_submissions (brain_region);
 * CREATE INDEX idx_submissions_dataset_hash ON community_submissions (dataset_hash);
 * ```
 */

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

  // Quality & deduplication
  dataset_hash: string;
  quality_score?: number;
  catune_version: string;

  // Extensible
  extra_metadata?: Record<string, unknown>;
}

/**
 * INSERT payload for community_submissions.
 * Omits id, created_at, and user_id which are auto-set by Supabase/RLS.
 */
export type SubmissionPayload = Omit<
  CommunitySubmission,
  'id' | 'created_at' | 'user_id'
>;

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
}

/** Result of parameter validation before submission. */
export interface QualityCheckResult {
  valid: boolean;
  score: number;
  issues: string[];
}
