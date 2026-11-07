-- CaDecon: replace the `upsample_factor` run parameter with `max_firing_rate`.
--
-- CaDecon no longer upsamples. Its one rate parameter is now `max_firing_rate`
-- (spikes per second, double precision, default 300; the solver validates
-- 0 < max_firing_rate <= 10000). Community submissions send it instead of
-- `upsample_factor`.
--
-- Strict and breaking by decision: CaDecon community submissions are unused so
-- far, so clients that still send `upsample_factor` are rejected (unknown
-- column), and a row without a valid `max_firing_rate` is rejected.
--
-- Changes to cadecon_submissions:
--   1. Add `max_firing_rate` (nullable at first).
--   2. Backfill existing rows: max_firing_rate = upsample_factor * sampling_rate
--      (the effective bin rate the old parameter implied), clamped into the
--      valid range (0.001, 10000] so the new CHECK always holds. Rows whose
--      product exceeds 10000 are therefore capped at 10000.
--   3. SET NOT NULL and add valid_max_firing_rate:
--      CHECK (max_firing_rate > 0 AND max_firing_rate <= 10000). The bound is
--      two-sided on purpose: Postgres orders float8 'NaN' above every other
--      value, so the finite upper bound rejects NaN and +Infinity, and `> 0`
--      rejects -Infinity (same trick as 014).
--   4. Drop cadecon_submissions_public (it references upsample_factor and
--      CREATE OR REPLACE VIEW cannot drop columns), drop `upsample_factor`
--      together with its CHECKs (014 valid_upsample_factor; 014 has no trigger
--      or function that references the column), then recreate the view with
--      max_firing_rate in place of upsample_factor and re-assert the 010/011
--      privileges (SELECT only for anon/authenticated).
--
-- Idempotent: every step checks for the column / constraint state first.

BEGIN;

ALTER TABLE cadecon_submissions
  ADD COLUMN IF NOT EXISTS max_firing_rate DOUBLE PRECISION;

-- Backfill only while the old column still exists (re-runs after the drop skip
-- this block).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'cadecon_submissions'
      AND column_name = 'upsample_factor'
  ) THEN
    UPDATE cadecon_submissions
    SET max_firing_rate = LEAST(10000::double precision,
                                GREATEST(0.001::double precision,
                                         upsample_factor::double precision * sampling_rate))
    WHERE max_firing_rate IS NULL;
  END IF;
END
$$;

ALTER TABLE cadecon_submissions
  ALTER COLUMN max_firing_rate SET NOT NULL;

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
END
$$;

DROP VIEW IF EXISTS cadecon_submissions_public;

ALTER TABLE cadecon_submissions
  DROP CONSTRAINT IF EXISTS valid_upsample_factor;

ALTER TABLE cadecon_submissions
  DROP COLUMN IF EXISTS upsample_factor;

CREATE VIEW cadecon_submissions_public
WITH (security_invoker = false) AS
SELECT
  id, created_at, user_id,
  tau_rise, tau_decay, t_peak, fwhm, beta, max_firing_rate, sampling_rate,
  num_subsets, target_coverage, max_iterations, convergence_tol,
  weighting_enabled, hp_filter_enabled, lp_filter_enabled,
  median_alpha, median_pve, mean_event_rate, num_iterations, converged,
  indicator, species, brain_region,
  virus_construct, time_since_injection_days,
  microscope_type, imaging_depth_um, cell_type,
  num_cells, recording_length_s, fps,
  dataset_hash, app_version, data_source,
  extra_metadata
FROM cadecon_submissions;

-- Re-assert the 011 privilege state (a fresh view starts with default grants).
REVOKE ALL ON cadecon_submissions_public FROM anon, authenticated, PUBLIC;
GRANT SELECT ON cadecon_submissions_public TO anon, authenticated;

COMMIT;
