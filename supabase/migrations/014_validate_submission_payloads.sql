-- Server-side validation of community submission payloads.
--
-- Problem: only tau_rise / tau_decay / t_peak / fwhm / lambda / sampling_rate /
-- data_source were CHECK-constrained (001, 006, 009). Everything else accepted
-- whatever a client with the anon key sent: negative counts and depths,
-- 'NaN' / 'Infinity' (PostgREST passes them through for float8), TEXT columns
-- of unbounded length, and an unbounded `extra_metadata` JSONB that is
-- republished to every visitor through the *_public views. Client and server
-- also disagreed: the CaTune client requires lambda >= 1e-6 and
-- sampling_rate >= 1, the table allowed lambda >= 0 and sampling_rate > 0.
--
-- Fix: CHECK constraints on every remaining client-supplied column.
--
-- NaN / Infinity: Postgres orders float8 'NaN' ABOVE every other value
-- (including 'Infinity'), so a finite upper bound rejects both NaN and
-- +Infinity, and a finite lower bound rejects -Infinity. Every float
-- constraint below is therefore two-sided on purpose.
--
-- Bounds come from the apps (packages/core param-config, the quality-checks
-- HARD_LIMITS, computeAR2) and are deliberately generous on the upper side:
-- they exist to reject garbage and abuse, not to second-guess science.
--
-- Text caps: 128 for short categorical fields (longest canonical option in
-- seed/field_options_seed.sql is 42 chars; free-text entry is allowed so
-- leave headroom), 256 for virus_construct / lab_name, 2000 for notes.
--
-- Rollout: every constraint is added NOT VALID, so this migration cannot fail
-- on rows that already exist; new INSERTs/UPDATEs are checked immediately.
-- After cleaning up violators, the operator runs
--   ALTER TABLE <table> VALIDATE CONSTRAINT <name>;
-- for each (see the PR description for the queries).
--
-- Idempotent: a constraint is only added if one with that name does not
-- already exist (so a re-run never un-validates a validated constraint).
--
-- Not done here (follow-up): tying indicator/species/brain_region/... to
-- field_options membership — that would reject today's free-text entries.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.add_check_not_valid(tbl regclass, cname TEXT, expr TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = tbl AND conname = cname
  ) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s) NOT VALID', tbl, cname, expr);
  END IF;
END
$$;

-- ── Columns shared by both submission tables ────────────────────────────────

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['catune_submissions', 'cadecon_submissions'] LOOP
    -- Text lengths
    PERFORM pg_temp.add_check_not_valid(t, 'valid_indicator_len', 'length(indicator) <= 128');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_species_len', 'length(species) <= 128');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_brain_region_len', 'length(brain_region) <= 128');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_microscope_type_len', 'length(microscope_type) <= 128');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_cell_type_len', 'length(cell_type) <= 128');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_virus_construct_len', 'length(virus_construct) <= 256');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_lab_name_len', 'length(lab_name) <= 256');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_notes_len', 'length(notes) <= 2000');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_dataset_hash_len', 'length(dataset_hash) <= 128');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_app_version_len', 'length(app_version) <= 64');

    -- ORCID iD (bare or as an orcid.org URL; last char may be the X checksum).
    PERFORM pg_temp.add_check_not_valid(t, 'valid_orcid',
      $c$orcid ~ '^(https?://orcid\.org/)?[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$'$c$);

    -- Numerics (NULL passes a CHECK; optional columns stay optional)
    PERFORM pg_temp.add_check_not_valid(t, 'valid_ar2_g1', 'ar2_g1 >= 0 AND ar2_g1 <= 2');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_ar2_g2', 'ar2_g2 >= -1 AND ar2_g2 <= 0');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_time_since_injection_days',
      'time_since_injection_days >= 0 AND time_since_injection_days <= 10000');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_num_cells', 'num_cells >= 0 AND num_cells <= 10000000');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_recording_length_s',
      'recording_length_s >= 0 AND recording_length_s <= 10000000');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_fps', 'fps > 0 AND fps <= 10000');
    PERFORM pg_temp.add_check_not_valid(t, 'valid_imaging_depth_um',
      'imaging_depth_um >= 0 AND imaging_depth_um <= 20000');

    -- extra_metadata: a JSON object, at most 4 KB serialized (same budget and
    -- measure as analytics_events.event_data in 008; length(::text) is used
    -- rather than pg_column_size because the latter measures the compressed
    -- on-disk size, which a repetitive payload can make arbitrarily small).
    PERFORM pg_temp.add_check_not_valid(t, 'valid_extra_metadata',
      $c$jsonb_typeof(extra_metadata) = 'object' AND length(extra_metadata::text) <= 4096$c$);
  END LOOP;
END
$$;

-- ── catune_submissions only ─────────────────────────────────────────────────

DO $$
BEGIN
  -- Align with the client's HARD_LIMITS (apps/catune quality-checks.ts).
  PERFORM pg_temp.add_check_not_valid('catune_submissions', 'valid_lambda_min', 'lambda >= 1e-6');
  PERFORM pg_temp.add_check_not_valid('catune_submissions', 'valid_sampling_rate_min', 'sampling_rate >= 1');
  PERFORM pg_temp.add_check_not_valid('catune_submissions', 'valid_quality_score',
    'quality_score >= -1000000 AND quality_score <= 1000000');
END
$$;

-- ── cadecon_submissions only ────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_beta',
    'beta >= -1000000000 AND beta <= 1000000000');
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_upsample_factor',
    'upsample_factor >= 1 AND upsample_factor <= 10000');
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_num_subsets',
    'num_subsets >= 1 AND num_subsets <= 10000');
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_target_coverage',
    'target_coverage > 0 AND target_coverage <= 1');
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_max_iterations',
    'max_iterations >= 1 AND max_iterations <= 100000');
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_convergence_tol',
    'convergence_tol > 0 AND convergence_tol <= 1');
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_median_alpha',
    'median_alpha >= -1000000000 AND median_alpha <= 1000000000');
  -- PVE = 1 - SS_res/SS_tot can be negative for a poor fit, never above 1.
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_median_pve',
    'median_pve >= -1000000 AND median_pve <= 1');
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_mean_event_rate',
    'mean_event_rate >= 0 AND mean_event_rate <= 1000000');
  PERFORM pg_temp.add_check_not_valid('cadecon_submissions', 'valid_num_iterations',
    'num_iterations >= 0 AND num_iterations <= 100000');
END
$$;

COMMIT;
