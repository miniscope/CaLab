-- Read-only schema fingerprint for the Admin "Schema status" panel.
--
-- Production migrations are applied by hand (no supabase_migrations table), so
-- a skipped file (008 and 015 once were) is invisible until something breaks.
-- This function reports, as one jsonb object of booleans, whether the objects
-- each migration introduces are present. It changes nothing and returns no row
-- data: only true/false per check. Keys are stable ids: "<migration>_<what>".
--
-- Optional: the Admin app works without it (the panel shows "unknown"). Run it
-- in the SQL editor like any other migration; idempotent. The keys and their
-- expected values are listed in supabase/README.md and mirrored in
-- apps/admin/src/lib/fingerprint.ts (keep the three in sync when adding one).
--
-- Access: SECURITY DEFINER (it reads pg_catalog), but it refuses callers that are
-- not admins (same JWT test as is_admin()) and is not executable by anon.

CREATE OR REPLACE FUNCTION public.schema_fingerprint()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' THEN
    RAISE EXCEPTION 'schema_fingerprint is admin only' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    '003_analytics_tables',
      to_regclass('public.analytics_sessions') IS NOT NULL
      AND to_regclass('public.analytics_events') IS NOT NULL,
    '004_is_admin_function',
      to_regprocedure('public.is_admin()') IS NOT NULL,
    '006_cadecon_table',
      to_regclass('public.cadecon_submissions') IS NOT NULL,
    '008_is_anonymous_column',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'analytics_sessions'
                AND column_name = 'is_anonymous'),
    '008_event_data_size_check',
      EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'analytics_events_event_data_size_check'
                AND conrelid = to_regclass('public.analytics_events')),
    '008_session_time_checks',
      EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'analytics_sessions_ended_at_order_check'
                AND conrelid = to_regclass('public.analytics_sessions'))
      AND EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'analytics_sessions_duration_bounds_check'
                    AND conrelid = to_regclass('public.analytics_sessions')),
    '008_permissive_policies_removed',
      NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public'
                    AND policyname IN ('Anyone can insert sessions',
                                       'Anyone can update session end',
                                       'Anyone can insert events')),
    '008_events_insert_policy',
      EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'analytics_events'
                AND policyname = 'Users insert events for own sessions'),
    '009_catune_tau_bounds',
      EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'valid_tau_decay'
                AND conrelid = to_regclass('public.catune_submissions')
                AND pg_get_constraintdef(oid) LIKE '%0.01%'),
    '010_public_views',
      to_regclass('public.catune_submissions_public') IS NOT NULL
      AND to_regclass('public.cadecon_submissions_public') IS NOT NULL,
    '010_owner_read_policy',
      EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'catune_submissions'
                AND policyname = 'Owner and admin read access'),
    '011_views_select_only',
      to_regclass('public.catune_submissions_public') IS NOT NULL
      AND to_regclass('public.cadecon_submissions_public') IS NOT NULL
      AND NOT has_table_privilege('anon', 'public.catune_submissions_public', 'INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('anon', 'public.cadecon_submissions_public', 'INSERT,UPDATE,DELETE'),
    '012_no_anonymous_submissions',
      EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'catune_submissions'
                AND policyname = 'Authenticated users can submit'
                AND with_check LIKE '%is_anonymous%'),
    '013_session_cap_trigger',
      EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'analytics_events_session_cap'
                AND tgrelid = to_regclass('public.analytics_events')),
    '013_client_session_insert_removed',
      NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'analytics_sessions'
                    AND policyname = 'Users insert own sessions'),
    '014_payload_checks',
      EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'valid_indicator_len'
                AND conrelid = to_regclass('public.catune_submissions')),
    '015_app_name_slug_check',
      EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'analytics_sessions_app_name_slug_check'
                AND conrelid = to_regclass('public.analytics_sessions')),
    '016_cadecon_max_firing_rate',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'cadecon_submissions'
                AND column_name = 'max_firing_rate')
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'cadecon_submissions'
                        AND column_name = 'upsample_factor'),
    '017_event_name_shape_check',
      EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'analytics_events_event_name_shape_check'
                AND conrelid = to_regclass('public.analytics_events')),
    '018_admin_read_indexes',
      EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public' AND indexname = 'idx_sessions_created_at_id')
      AND EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'idx_events_created_at_id')
  );
END
$$;

REVOKE ALL ON FUNCTION public.schema_fingerprint() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schema_fingerprint() TO authenticated;
