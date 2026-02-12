-- Community submissions table
-- Run in Supabase Dashboard -> SQL Editor

CREATE TABLE community_submissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  user_id UUID REFERENCES auth.users(id) NOT NULL,

  -- Core parameters (always present, queryable)
  tau_rise DOUBLE PRECISION NOT NULL,
  tau_decay DOUBLE PRECISION NOT NULL,
  lambda DOUBLE PRECISION NOT NULL,
  sampling_rate DOUBLE PRECISION NOT NULL,

  -- AR2 coefficients (auto-computed)
  ar2_g1 DOUBLE PRECISION NOT NULL,
  ar2_g2 DOUBLE PRECISION NOT NULL,

  -- Required metadata (flat, filterable)
  indicator TEXT NOT NULL,
  species TEXT NOT NULL,
  brain_region TEXT NOT NULL,

  -- Optional metadata
  lab_name TEXT,
  orcid TEXT,
  virus_construct TEXT,
  time_since_injection_days INTEGER,
  notes TEXT,

  -- Dataset metadata
  num_cells INTEGER,
  recording_length_s DOUBLE PRECISION,
  fps DOUBLE PRECISION,

  -- Quality & deduplication
  dataset_hash TEXT NOT NULL,
  quality_score DOUBLE PRECISION,
  catune_version TEXT NOT NULL,

  -- Data source tracking
  data_source TEXT NOT NULL DEFAULT 'user',

  -- Optional experiment metadata
  microscope_type TEXT,
  imaging_depth_um DOUBLE PRECISION,
  cell_type TEXT,

  -- Extensible metadata
  extra_metadata JSONB DEFAULT '{}'::jsonb,

  -- Constraints
  CONSTRAINT valid_tau_rise CHECK (tau_rise > 0 AND tau_rise < 1),
  CONSTRAINT valid_tau_decay CHECK (tau_decay > 0 AND tau_decay < 10),
  CONSTRAINT valid_lambda CHECK (lambda > 0 AND lambda < 1),
  CONSTRAINT valid_sampling_rate CHECK (sampling_rate > 0 AND sampling_rate <= 1000),
  CONSTRAINT valid_data_source CHECK (data_source IN ('user', 'demo', 'training'))
);

-- Enable RLS
ALTER TABLE community_submissions ENABLE ROW LEVEL SECURITY;

-- Anyone can read submissions (community browsing)
CREATE POLICY "Public read access"
ON community_submissions FOR SELECT
TO anon, authenticated
USING (true);

-- Only authenticated users can insert
CREATE POLICY "Authenticated users can submit"
ON community_submissions FOR INSERT
TO authenticated
WITH CHECK ((select auth.uid()) = user_id);

-- Users can only delete their own submissions
CREATE POLICY "Users can delete own submissions"
ON community_submissions FOR DELETE
TO authenticated
USING ((select auth.uid()) = user_id);

-- Performance indexes
CREATE INDEX idx_submissions_user_id ON community_submissions USING btree (user_id);
CREATE INDEX idx_submissions_indicator ON community_submissions (indicator);
CREATE INDEX idx_submissions_species ON community_submissions (species);
CREATE INDEX idx_submissions_brain_region ON community_submissions (brain_region);
CREATE INDEX idx_submissions_dataset_hash ON community_submissions (dataset_hash);
