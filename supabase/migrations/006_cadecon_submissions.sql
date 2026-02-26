-- CaDecon community submissions table
-- Stores converged kernel parameters and aggregate statistics

CREATE TABLE cadecon_submissions (
  -- System
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  user_id UUID REFERENCES auth.users(id) NOT NULL,

  -- CaDecon-specific: kernel results
  tau_rise DOUBLE PRECISION NOT NULL,
  tau_decay DOUBLE PRECISION NOT NULL,
  beta DOUBLE PRECISION,
  ar2_g1 DOUBLE PRECISION NOT NULL,
  ar2_g2 DOUBLE PRECISION NOT NULL,

  -- CaDecon-specific: run config
  upsample_factor INTEGER NOT NULL,
  sampling_rate DOUBLE PRECISION NOT NULL,
  num_subsets INTEGER NOT NULL,
  target_coverage DOUBLE PRECISION NOT NULL,
  max_iterations INTEGER NOT NULL,
  convergence_tol DOUBLE PRECISION NOT NULL,
  weighting_enabled BOOLEAN DEFAULT false,
  hp_filter_enabled BOOLEAN DEFAULT false,
  lp_filter_enabled BOOLEAN DEFAULT false,

  -- CaDecon-specific: aggregate results
  median_alpha DOUBLE PRECISION,
  median_pve DOUBLE PRECISION,
  mean_event_rate DOUBLE PRECISION,
  num_iterations INTEGER NOT NULL,
  converged BOOLEAN NOT NULL,

  -- Required metadata (base)
  indicator TEXT NOT NULL,
  species TEXT NOT NULL,
  brain_region TEXT NOT NULL,

  -- Optional metadata
  lab_name TEXT, orcid TEXT, virus_construct TEXT,
  time_since_injection_days INTEGER, notes TEXT,
  microscope_type TEXT, imaging_depth_um DOUBLE PRECISION,
  cell_type TEXT,

  -- Dataset metadata
  num_cells INTEGER,
  recording_length_s DOUBLE PRECISION,
  fps DOUBLE PRECISION,

  -- Deduplication & versioning
  dataset_hash TEXT NOT NULL,
  app_version TEXT NOT NULL,

  -- Data source
  data_source TEXT NOT NULL DEFAULT 'user',
  extra_metadata JSONB DEFAULT '{}'::jsonb,

  -- Constraints
  CONSTRAINT valid_tau_rise CHECK (tau_rise > 0 AND tau_rise < 1),
  CONSTRAINT valid_tau_decay CHECK (tau_decay > 0 AND tau_decay < 10),
  CONSTRAINT valid_sampling_rate CHECK (sampling_rate > 0 AND sampling_rate <= 1000),
  CONSTRAINT valid_data_source CHECK (data_source IN ('user', 'demo', 'training', 'bridge'))
);

-- RLS (same pattern as catune_submissions)
ALTER TABLE cadecon_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON cadecon_submissions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Auth insert" ON cadecon_submissions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own delete" ON cadecon_submissions FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Admin delete" ON cadecon_submissions FOR DELETE TO authenticated USING (is_admin());

-- Indexes
CREATE INDEX idx_cadecon_user ON cadecon_submissions(user_id);
CREATE INDEX idx_cadecon_indicator ON cadecon_submissions(indicator);
CREATE INDEX idx_cadecon_species ON cadecon_submissions(species);
CREATE INDEX idx_cadecon_brain_region ON cadecon_submissions(brain_region);
CREATE INDEX idx_cadecon_hash ON cadecon_submissions(dataset_hash);
