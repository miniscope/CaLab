-- CaDecon: replace the `upsample_factor` run parameter with `max_firing_rate`.
--
-- CaDecon no longer upsamples. Its one rate parameter is now `max_firing_rate`
-- (spikes per second, double precision, default 300; the solver validates
-- 0 < max_firing_rate <= 10000). Community submissions send it instead of
-- `upsample_factor`.
--
-- Changes to cadecon_submissions:
--   1. New nullable column `max_firing_rate`, CHECK (> 0 AND <= 10000). The
--      bound is two-sided on purpose: Postgres orders float8 'NaN' above every
--      other value, so a finite upper bound rejects NaN and +Infinity, and
--      `> 0` rejects -Infinity (same trick as 014).
--   2. `upsample_factor` becomes nullable. Existing rows keep their value and
--      the existing valid_upsample_factor CHECK (014) stays: NULL passes it.
--   3. `valid_rate_param` requires AT LEAST ONE of the two. A new client sends
--      max_firing_rate; a not-yet-refreshed old client (cached bundle) still
--      sends only upsample_factor and is still accepted. A row with neither is
--      rejected. A row may carry both (old rows never have max_firing_rate).
--      Once old clients are gone this can be tightened to
--      `max_firing_rate IS NOT NULL` (old rows would need that constraint added
--      NOT VALID, as in 014).
--   4. cadecon_submissions_public exposes max_firing_rate and keeps exposing
--      upsample_factor (for old rows). CREATE OR REPLACE VIEW can only append
--      columns, so max_firing_rate goes last; grants from 010/011 are kept by
--      OR REPLACE (SELECT only for anon/authenticated).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP NOT NULL is a no-op when already
-- nullable, constraints are only added if absent, view is CREATE OR REPLACE.

BEGIN;

ALTER TABLE cadecon_submissions
  ADD COLUMN IF NOT EXISTS max_firing_rate DOUBLE PRECISION;

ALTER TABLE cadecon_submissions
  ALTER COLUMN upsample_factor DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cadecon_submissions'::regclass
      AND conname = 'valid_max_firing_rate'
  ) THEN
    ALTER TABLE cadecon_submissions
      ADD CONSTRAINT valid_max_firing_rate
      CHECK (max_firing_rate > 0 AND max_firing_rate <= 10000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cadecon_submissions'::regclass
      AND conname = 'valid_rate_param'
  ) THEN
    -- Every existing row has upsample_factor NOT NULL (006), so this is safe
    -- to add validated.
    ALTER TABLE cadecon_submissions
      ADD CONSTRAINT valid_rate_param
      CHECK (max_firing_rate IS NOT NULL OR upsample_factor IS NOT NULL);
  END IF;
END
$$;

CREATE OR REPLACE VIEW cadecon_submissions_public
WITH (security_invoker = false) AS
SELECT
  id, created_at, user_id,
  tau_rise, tau_decay, t_peak, fwhm, beta, upsample_factor, sampling_rate,
  num_subsets, target_coverage, max_iterations, convergence_tol,
  weighting_enabled, hp_filter_enabled, lp_filter_enabled,
  median_alpha, median_pve, mean_event_rate, num_iterations, converged,
  indicator, species, brain_region,
  virus_construct, time_since_injection_days,
  microscope_type, imaging_depth_um, cell_type,
  num_cells, recording_length_s, fps,
  dataset_hash, app_version, data_source,
  extra_metadata,
  max_firing_rate
FROM cadecon_submissions;

-- Re-assert the 011 privilege state (no-ops if unchanged).
REVOKE ALL ON cadecon_submissions_public FROM anon, authenticated, PUBLIC;
GRANT SELECT ON cadecon_submissions_public TO anon, authenticated;

COMMIT;
