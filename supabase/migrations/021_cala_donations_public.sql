-- Public sharing of donations on DANDI (apps/cala/docs/data-donation.md).
--
-- Donation project only (like 020); never applied to the main project, and not
-- part of schema_fingerprint() (019), which checks the main project.
--
-- Adds the donor's sharing choice (public on DANDI | CaLab only), the subject
-- fields DANDI needs, a `published` status set by the lab, and a PII-free
-- public view of published public donations for cala's browse page.
--
-- Existing rows become sharing = 'lab' with NULL subject fields: they were
-- donated under the lab-only text. The edge function requires the subject
-- fields for every new donation; the table requires them only on a published
-- row (published_complete), so old rows stay valid.
--
-- session_date "not in the future" is checked by the edge function (CHECKs
-- must be immutable); the table bounds it to 1990..2100.

BEGIN;

ALTER TABLE public.cala_donations
  ADD COLUMN IF NOT EXISTS sharing TEXT NOT NULL DEFAULT 'lab',
  ADD COLUMN IF NOT EXISTS subject_id TEXT,
  ADD COLUMN IF NOT EXISTS subject_sex TEXT,
  ADD COLUMN IF NOT EXISTS subject_age TEXT,
  ADD COLUMN IF NOT EXISTS session_date DATE,
  ADD COLUMN IF NOT EXISTS genotype TEXT,
  ADD COLUMN IF NOT EXISTS dandi_path TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE public.cala_donations DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE public.cala_donations ADD CONSTRAINT valid_status CHECK (
  status IN ('uploading', 'uploaded', 'approved', 'rejected', 'ingested', 'withdrawn', 'published')
);

ALTER TABLE public.cala_donations
  DROP CONSTRAINT IF EXISTS valid_sharing,
  DROP CONSTRAINT IF EXISTS valid_sharing_license,
  DROP CONSTRAINT IF EXISTS valid_subject_id,
  DROP CONSTRAINT IF EXISTS valid_subject_sex,
  DROP CONSTRAINT IF EXISTS valid_subject_age,
  DROP CONSTRAINT IF EXISTS valid_session_date,
  DROP CONSTRAINT IF EXISTS valid_genotype_len,
  DROP CONSTRAINT IF EXISTS valid_dandi_path,
  DROP CONSTRAINT IF EXISTS published_complete;

ALTER TABLE public.cala_donations
  ADD CONSTRAINT valid_sharing CHECK (sharing IN ('public', 'lab')),
  -- A public donation is always CC BY 4.0; a lab one may carry either (old rows).
  ADD CONSTRAINT valid_sharing_license CHECK (sharing = 'lab' OR license = 'cc-by-4.0'),
  ADD CONSTRAINT valid_subject_id CHECK (subject_id ~ '^[A-Za-z0-9-]{1,64}$'),
  ADD CONSTRAINT valid_subject_sex CHECK (subject_sex IN ('M', 'F', 'U', 'O')),
  ADD CONSTRAINT valid_subject_age CHECK (
    length(subject_age) <= 16
    AND subject_age ~ '^P[0-9]'
    AND subject_age ~ '^P([0-9]+Y)?([0-9]+M)?([0-9]+W)?([0-9]+D)?$'
  ),
  ADD CONSTRAINT valid_session_date CHECK (
    session_date >= DATE '1990-01-01' AND session_date < DATE '2100-01-01'
  ),
  ADD CONSTRAINT valid_genotype_len CHECK (length(genotype) <= 128),
  ADD CONSTRAINT valid_dandi_path CHECK (
    length(dandi_path) <= 256
    AND dandi_path ~ '^sub-[A-Za-z0-9-]+/[A-Za-z0-9_.+-]+\.nwb$'
  ),
  ADD CONSTRAINT published_complete CHECK (
    status <> 'published' OR (
      sharing = 'public'
      AND subject_id IS NOT NULL AND subject_sex IS NOT NULL
      AND subject_age IS NOT NULL AND session_date IS NOT NULL
      AND dandi_path IS NOT NULL AND published_at IS NOT NULL
    )
  );

-- What cala's browse page shows: published public donations, recording
-- metadata and the donor-chosen credit only (no user id, email, notes, review
-- fields or file list). Runs with the owner's privileges, like the *_public
-- views of 010, so anon sees these rows although the base table is hidden.
CREATE OR REPLACE VIEW public.cala_donations_public
WITH (security_invoker = false) AS
SELECT
  id, published_at, indicator, species, brain_region, expression, preparation,
  behavior, scope, fps, width, height, n_frames, bytes_per_pixel, depth_um,
  subject_sex, subject_age, genotype, credit_name, credit_lab, dandi_path
FROM public.cala_donations
WHERE sharing = 'public' AND status = 'published';

REVOKE ALL ON public.cala_donations_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cala_donations_public TO anon, authenticated;

COMMIT;
