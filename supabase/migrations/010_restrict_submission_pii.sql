-- Restrict read access to submission tables and expose PII-free public views.
--
-- Problem (audit H1): migrations 001/006 granted submission SELECT to
-- `anon, authenticated USING (true)`, so any unauthenticated visitor with the
-- public anon key could read every submission's free-text PII — `orcid` (a
-- globally unique researcher ID), `lab_name`, and `notes` — and deanonymize
-- who submitted what. This contradicts the project's "don't leak data between
-- users" goal.
--
-- Fix: base-table SELECT is now owner-or-admin only. Community browsing reads
-- a dedicated view that exposes every column EXCEPT those three PII fields.
-- No app reads orcid/lab_name/notes (they are write-only submission metadata),
-- so this is non-breaking for the CaTune/CaDecon community browsers and the
-- admin dashboard.
--
-- The *_public views intentionally run with the view owner's privileges
-- (security_invoker = false, the default) so community browsing still sees
-- every contributor's submission — only the PII columns are dropped, not the
-- rows. Writes and deletes continue against the base tables under the existing
-- owner-scoped policies.

BEGIN;

-- ── catune_submissions ──────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read access" ON catune_submissions;

CREATE POLICY "Owner and admin read access"
ON catune_submissions FOR SELECT
TO anon, authenticated
USING ((select auth.uid()) = user_id OR public.is_admin());

CREATE VIEW catune_submissions_public
WITH (security_invoker = false) AS
SELECT
  id, created_at, user_id,
  tau_rise, tau_decay, t_peak, fwhm, lambda, sampling_rate,
  ar2_g1, ar2_g2,
  indicator, species, brain_region,
  filter_enabled,
  virus_construct, time_since_injection_days,
  num_cells, recording_length_s, fps,
  dataset_hash, quality_score, app_version, data_source,
  microscope_type, imaging_depth_um, cell_type,
  extra_metadata
FROM catune_submissions;

GRANT SELECT ON catune_submissions_public TO anon, authenticated;

-- ── cadecon_submissions ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read" ON cadecon_submissions;

CREATE POLICY "Owner and admin read access"
ON cadecon_submissions FOR SELECT
TO anon, authenticated
USING ((select auth.uid()) = user_id OR public.is_admin());

CREATE VIEW cadecon_submissions_public
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
  extra_metadata
FROM cadecon_submissions;

GRANT SELECT ON cadecon_submissions_public TO anon, authenticated;

COMMIT;
