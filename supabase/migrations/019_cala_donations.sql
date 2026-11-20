-- Raw data donations from browser cala (apps/cala/docs/data-donation.md).
--
-- One row per donated recording. The files themselves live in a Cloudflare R2
-- bucket (pending/<id>/ -> approved/<id>/ -> deleted after lab ingest); this
-- table holds the metadata, the declared file list and the moderation state.
--
-- Write path: ONLY the `donation` edge function (supabase/functions/donation),
-- which runs with the service_role key and enforces auth (real, non-anonymous
-- sign-in), caps and the status machine:
--
--   uploading -> uploaded -> approved -> ingested
--                         \-> rejected
--   uploading | uploaded | approved -> withdrawn   (by the donor)
--
-- API roles:
--   * SELECT: the donor sees their own rows, an admin (004 is_admin()) sees all.
--   * INSERT / DELETE: none (revoked; the preamble mirrors Supabase's default
--     GRANT ALL to anon/authenticated, so revoking is what actually closes it).
--   * UPDATE: only `in_benchmark` and `benchmark_note`, only by an admin
--     (column grant + row policy). Status, files and metadata are never
--     client-writable.
--
-- CHECKs follow 014: two-sided bounds on every float (rejects NaN/Infinity),
-- length caps on every text column. The edge function validates the same
-- ranges first so clients get a readable error; these are the backstop.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cala_donations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'uploading',

  -- Biology
  indicator TEXT NOT NULL,
  species TEXT NOT NULL,
  brain_region TEXT NOT NULL,
  expression TEXT,
  preparation TEXT,
  behavior TEXT,

  -- Optics / recording
  scope TEXT NOT NULL,
  depth_um DOUBLE PRECISION,
  led_power TEXT,
  fps DOUBLE PRECISION NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  n_frames INTEGER NOT NULL,
  bytes_per_pixel SMALLINT NOT NULL,

  -- Provenance
  cala_version TEXT NOT NULL,
  dataset_hash TEXT,

  -- Consent
  license TEXT NOT NULL,
  rights_attested BOOLEAN NOT NULL,
  protocol_attested BOOLEAN NOT NULL,
  contact_ok BOOLEAN NOT NULL,

  -- Credit (donor-chosen, shown in the benchmark list)
  credit_name TEXT,
  credit_lab TEXT,
  notes TEXT,

  -- Files: [{name, bytes}, ...], exact compressed sizes
  declared_bytes BIGINT NOT NULL,
  n_chunks INTEGER NOT NULL,
  files JSONB NOT NULL,

  -- Benchmark (admin) and moderation
  in_benchmark BOOLEAN NOT NULL DEFAULT false,
  benchmark_note TEXT,
  review_note TEXT,

  CONSTRAINT valid_status CHECK (
    status IN ('uploading', 'uploaded', 'approved', 'rejected', 'ingested', 'withdrawn')
  ),
  CONSTRAINT valid_indicator CHECK (length(indicator) BETWEEN 1 AND 128),
  CONSTRAINT valid_species CHECK (length(species) BETWEEN 1 AND 128),
  CONSTRAINT valid_brain_region CHECK (length(brain_region) BETWEEN 1 AND 128),
  CONSTRAINT valid_scope CHECK (length(scope) BETWEEN 1 AND 128),
  CONSTRAINT valid_expression_len CHECK (length(expression) <= 128),
  CONSTRAINT valid_preparation_len CHECK (length(preparation) <= 128),
  CONSTRAINT valid_behavior_len CHECK (length(behavior) <= 256),
  CONSTRAINT valid_led_power_len CHECK (length(led_power) <= 64),
  CONSTRAINT valid_depth_um CHECK (depth_um >= 0 AND depth_um <= 10000),
  CONSTRAINT valid_fps CHECK (fps > 0 AND fps <= 1000),
  CONSTRAINT valid_width CHECK (width BETWEEN 1 AND 16384),
  CONSTRAINT valid_height CHECK (height BETWEEN 1 AND 16384),
  CONSTRAINT valid_n_frames CHECK (n_frames > 0),
  CONSTRAINT valid_bytes_per_pixel CHECK (bytes_per_pixel IN (1, 2)),
  CONSTRAINT valid_cala_version CHECK (length(cala_version) BETWEEN 1 AND 64),
  CONSTRAINT valid_dataset_hash_len CHECK (length(dataset_hash) <= 128),
  CONSTRAINT valid_license CHECK (license IN ('cc-by-4.0', 'lab-use-only')),
  CONSTRAINT valid_rights_attested CHECK (rights_attested = true),
  CONSTRAINT valid_protocol_attested CHECK (protocol_attested = true),
  CONSTRAINT valid_credit_name_len CHECK (length(credit_name) <= 100),
  CONSTRAINT valid_credit_lab_len CHECK (length(credit_lab) <= 100),
  CONSTRAINT valid_notes_len CHECK (length(notes) <= 1000),
  CONSTRAINT valid_declared_bytes CHECK (declared_bytes > 0),
  CONSTRAINT valid_n_chunks CHECK (n_chunks BETWEEN 1 AND 10000),
  -- chunks + timestamps.csv + meta.json
  CONSTRAINT valid_files CHECK (
    jsonb_typeof(files) = 'array'
    AND jsonb_array_length(files) BETWEEN 1 AND 10002
  ),
  CONSTRAINT valid_benchmark_note_len CHECK (length(benchmark_note) <= 500),
  CONSTRAINT valid_review_note_len CHECK (length(review_note) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_cala_donations_status ON public.cala_donations (status);
CREATE INDEX IF NOT EXISTS idx_cala_donations_user_id ON public.cala_donations (user_id);

-- updated_at follows every UPDATE (edge function transitions and the admin
-- benchmark flag alike).
CREATE OR REPLACE FUNCTION public.cala_donations_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.cala_donations_touch_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cala_donations_updated_at ON public.cala_donations;
CREATE TRIGGER cala_donations_updated_at
  BEFORE UPDATE ON public.cala_donations
  FOR EACH ROW
  EXECUTE FUNCTION public.cala_donations_touch_updated_at();

-- Bytes declared by donations that still occupy the bucket. The edge function
-- (service_role) checks the global cap with it; PostgREST has no aggregates
-- by default, and summing client-side would be cut at the max-rows limit.
CREATE OR REPLACE FUNCTION public.cala_donations_open_bytes()
RETURNS BIGINT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(sum(declared_bytes), 0)::bigint
  FROM public.cala_donations
  WHERE status IN ('uploading', 'uploaded', 'approved')
$$;

REVOKE ALL ON FUNCTION public.cala_donations_open_bytes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cala_donations_open_bytes() TO service_role;

-- ── Privileges ──────────────────────────────────────────────────────────────

ALTER TABLE public.cala_donations ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cala_donations
  FROM anon, authenticated;
REVOKE UPDATE ON public.cala_donations FROM anon, authenticated;
GRANT UPDATE (in_benchmark, benchmark_note) ON public.cala_donations TO authenticated;

-- ── Policies ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Owner or admin reads donations" ON public.cala_donations;
CREATE POLICY "Owner or admin reads donations"
  ON public.cala_donations FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id OR public.is_admin());

DROP POLICY IF EXISTS "Admin sets benchmark fields" ON public.cala_donations;
CREATE POLICY "Admin sets benchmark fields"
  ON public.cala_donations FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

COMMIT;
