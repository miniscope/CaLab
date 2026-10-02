-- RLS policy test matrix.
--
-- Boots every migration in supabase/migrations/ against a Postgres instance
-- seeded by preamble.sql, then asserts the owner/non-owner/anon/admin matrix
-- for:
--   - catune_submissions, cadecon_submissions  (INSERT, DELETE)
--   - catune_submissions_public,
--     cadecon_submissions_public               (SELECT only; writes denied)
--   - analytics_sessions, analytics_events     (INSERT, UPDATE, SELECT)
--   - field_options                            (INSERT as anon — denied)
--
-- Failures RAISE EXCEPTION; a clean run ends with the final NOTICE. The
-- scripts/test-rls.sh runner grep's stderr for EXCEPTION to set exit code.
--
-- Test identity switching: each test block uses
--   SET LOCAL ROLE authenticated;
--   SET LOCAL "request.jwt.claims" = '{"sub":"<uuid>","role":"authenticated"}'
-- which drives auth.uid() via the preamble shim, so RLS policies evaluate
-- against the right user id.

BEGIN;

-- ── Fixtures ───────────────────────────────────────────────────────────────

INSERT INTO auth.users (id, email, raw_app_meta_data, is_anonymous) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@test', '{}', false),
  ('22222222-2222-2222-2222-222222222222', 'bob@test',   '{}', false),
  ('33333333-3333-3333-3333-333333333333', 'admin@test', '{"role":"admin"}', false),
  ('44444444-4444-4444-4444-444444444444', 'anon@test',  '{}', true);

-- Service-role seed: alice creates a catune submission that bob will try to
-- delete, and both bob and alice seed their own rows for DELETE tests.
INSERT INTO catune_submissions (
  user_id, tau_rise, tau_decay, t_peak, fwhm, lambda, sampling_rate,
  ar2_g1, ar2_g2, indicator, species, brain_region,
  dataset_hash, app_version
) VALUES
  ('11111111-1111-1111-1111-111111111111', 0.05, 0.4, 0.1, 0.3, 0.01, 30,
   0.9, -0.1, 'GCaMP6f', 'mouse', 'V1', 'hash-alice', 'test'),
  ('22222222-2222-2222-2222-222222222222', 0.05, 0.4, 0.1, 0.3, 0.01, 30,
   0.9, -0.1, 'GCaMP6f', 'mouse', 'V1', 'hash-bob', 'test');

INSERT INTO cadecon_submissions (
  user_id, tau_rise, tau_decay, t_peak, fwhm, ar2_g1, ar2_g2,
  upsample_factor, sampling_rate, num_subsets, target_coverage,
  max_iterations, convergence_tol, num_iterations, converged,
  indicator, species, brain_region, dataset_hash, app_version
) VALUES
  ('11111111-1111-1111-1111-111111111111', 0.05, 0.4, 0.1, 0.3, 0.9, -0.1,
   10, 30, 4, 0.25, 20, 0.01, 10, true,
   'GCaMP6f', 'mouse', 'V1', 'hash-alice', 'test'),
  ('22222222-2222-2222-2222-222222222222', 0.05, 0.4, 0.1, 0.3, 0.9, -0.1,
   10, 30, 4, 0.25, 20, 0.01, 10, true,
   'GCaMP6f', 'mouse', 'V1', 'hash-bob', 'test');

-- One session per real user so the event-insert test has something to query
-- against via the cross-check subquery in policy 008.
INSERT INTO analytics_sessions (id, anonymous_id, user_id, is_anonymous, app_name, app_version) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'anon-alice',
   '11111111-1111-1111-1111-111111111111', false, 'catune', 'test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'anon-bob',
   '22222222-2222-2222-2222-222222222222', false, 'catune', 'test');

-- ── Helpers ────────────────────────────────────────────────────────────────

-- assert_denied runs `sql` and requires it to fail with exactly
-- `expected_state`. Any other outcome fails the suite:
--   * success                      -> "EXPECTED DENY BUT PASSED"
--   * a different SQLSTATE         -> "WRONG SQLSTATE" (so a typo'd column or
--                                     table name can no longer masquerade as
--                                     a successful denial)
-- Common states:
--   42501 insufficient_privilege  (missing GRANT *and* RLS WITH CHECK failure)
--   23514 check_violation         (CHECK constraint)
--   42703 undefined_column        (column intentionally absent from a view)
CREATE OR REPLACE FUNCTION assert_denied(
  sql TEXT,
  label TEXT,
  expected_state TEXT DEFAULT '42501'
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_state THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'WRONG SQLSTATE (%): expected %, got % (%)',
      label, expected_state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'EXPECTED DENY BUT PASSED: %', label;
END
$$;

CREATE OR REPLACE FUNCTION assert_allowed(sql TEXT, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE sql;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'EXPECTED ALLOW BUT FAILED (%): %', label, SQLERRM;
END
$$;

CREATE OR REPLACE FUNCTION assert_row_count(sql TEXT, expected INTEGER, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  actual INTEGER;
BEGIN
  EXECUTE sql INTO actual;
  IF actual <> expected THEN
    RAISE EXCEPTION 'ROW-COUNT MISMATCH (%): expected %, got %', label, expected, actual;
  END IF;
END
$$;

COMMIT;

-- ── catune_submissions: owner INSERT allowed ───────────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_allowed(
  $sql$
  INSERT INTO catune_submissions (
    user_id, tau_rise, tau_decay, t_peak, fwhm, lambda, sampling_rate,
    ar2_g1, ar2_g2, indicator, species, brain_region, dataset_hash, app_version
  ) VALUES (
    '11111111-1111-1111-1111-111111111111', 0.05, 0.4, 0.1, 0.3, 0.01, 30,
    0.9, -0.1, 'GCaMP6f', 'mouse', 'V1', 'hash-alice-own', 'test'
  )
  $sql$,
  'catune own INSERT'
);
ROLLBACK;

-- ── catune_submissions: INSERT with a foreign user_id denied ───────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
SELECT assert_denied(
  $sql$
  INSERT INTO catune_submissions (
    user_id, tau_rise, tau_decay, t_peak, fwhm, lambda, sampling_rate,
    ar2_g1, ar2_g2, indicator, species, brain_region, dataset_hash, app_version
  ) VALUES (
    '11111111-1111-1111-1111-111111111111', 0.05, 0.4, 0.1, 0.3, 0.01, 30,
    0.9, -0.1, 'GCaMP6f', 'mouse', 'V1', 'hash-foreign', 'test'
  )
  $sql$,
  'catune INSERT forging foreign user_id'
);
ROLLBACK;

-- ── submissions: anonymous-auth users cannot submit (012) ─────────────────

-- signInAnonymously() users carry the `authenticated` role plus an
-- `is_anonymous: true` claim. They must not be able to post submissions even
-- for their own user_id.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","is_anonymous":true}';
SELECT assert_denied(
  $sql$
  INSERT INTO catune_submissions (
    user_id, tau_rise, tau_decay, t_peak, fwhm, lambda, sampling_rate,
    ar2_g1, ar2_g2, indicator, species, brain_region, dataset_hash, app_version
  ) VALUES (
    '44444444-4444-4444-4444-444444444444', 0.05, 0.4, 0.1, 0.3, 0.01, 30,
    0.9, -0.1, 'GCaMP6f', 'mouse', 'V1', 'hash-anon', 'test'
  )
  $sql$,
  'catune INSERT by anonymous-auth user denied'
);
SELECT assert_denied(
  $sql$
  INSERT INTO cadecon_submissions (
    user_id, tau_rise, tau_decay, t_peak, fwhm, ar2_g1, ar2_g2,
    upsample_factor, sampling_rate, num_subsets, target_coverage,
    max_iterations, convergence_tol, num_iterations, converged,
    indicator, species, brain_region, dataset_hash, app_version
  ) VALUES (
    '44444444-4444-4444-4444-444444444444', 0.05, 0.4, 0.1, 0.3, 0.9, -0.1,
    10, 30, 4, 0.25, 20, 0.01, 10, true,
    'GCaMP6f', 'mouse', 'V1', 'hash-anon', 'test'
  )
  $sql$,
  'cadecon INSERT by anonymous-auth user denied'
);
ROLLBACK;

-- A real user whose JWT carries is_anonymous=false explicitly (what Supabase
-- issues after magic-link sign-in) can still submit to both tables.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","is_anonymous":false}';
SELECT assert_allowed(
  $sql$
  INSERT INTO catune_submissions (
    user_id, tau_rise, tau_decay, t_peak, fwhm, lambda, sampling_rate,
    ar2_g1, ar2_g2, indicator, species, brain_region, dataset_hash, app_version
  ) VALUES (
    '11111111-1111-1111-1111-111111111111', 0.05, 0.4, 0.1, 0.3, 0.01, 30,
    0.9, -0.1, 'GCaMP6f', 'mouse', 'V1', 'hash-alice-real', 'test'
  )
  $sql$,
  'catune INSERT by real user (is_anonymous=false)'
);
SELECT assert_allowed(
  $sql$
  INSERT INTO cadecon_submissions (
    user_id, tau_rise, tau_decay, t_peak, fwhm, ar2_g1, ar2_g2,
    upsample_factor, sampling_rate, num_subsets, target_coverage,
    max_iterations, convergence_tol, num_iterations, converged,
    indicator, species, brain_region, dataset_hash, app_version
  ) VALUES (
    '11111111-1111-1111-1111-111111111111', 0.05, 0.4, 0.1, 0.3, 0.9, -0.1,
    10, 30, 4, 0.25, 20, 0.01, 10, true,
    'GCaMP6f', 'mouse', 'V1', 'hash-alice-real', 'test'
  )
  $sql$,
  'cadecon INSERT by real user (is_anonymous=false)'
);
ROLLBACK;

-- ── catune_submissions: cross-user DELETE denied ───────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
-- Bob tries to delete Alice's row. DELETE policy uses auth.uid() = user_id,
-- so RLS filters the candidate rows to zero → query succeeds with 0 rows
-- affected. Assert no rows were deleted.
DELETE FROM catune_submissions WHERE dataset_hash = 'hash-alice';
-- Verify under a privileged identity: as of migration 010, bob can no longer
-- SELECT alice's row (reads are owner-or-admin only), so the existence check
-- must run with RLS bypassed or it would read 0 for the wrong reason.
RESET ROLE;
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM catune_submissions WHERE dataset_hash = 'hash-alice'$sql$,
  1,
  'catune cross-user DELETE must not remove row'
);
ROLLBACK;

-- ── catune_submissions: admin DELETE allowed ───────────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","app_metadata":{"role":"admin"}}';
DELETE FROM catune_submissions WHERE dataset_hash = 'hash-alice';
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM catune_submissions WHERE dataset_hash = 'hash-alice'$sql$,
  0,
  'catune admin DELETE removes row'
);
ROLLBACK;

-- ── cadecon_submissions: owner DELETE allowed ──────────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
DELETE FROM cadecon_submissions WHERE dataset_hash = 'hash-alice';
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM cadecon_submissions WHERE dataset_hash = 'hash-alice'$sql$,
  0,
  'cadecon own DELETE removes row'
);
ROLLBACK;

-- ── cadecon_submissions: cross-user DELETE filtered ────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
DELETE FROM cadecon_submissions WHERE dataset_hash = 'hash-alice';
-- See note above: bob cannot read alice's row post-010, so verify privileged.
RESET ROLE;
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM cadecon_submissions WHERE dataset_hash = 'hash-alice'$sql$,
  1,
  'cadecon cross-user DELETE must not remove row'
);
ROLLBACK;

-- ── submission PII lockdown (migration 010) ────────────────────────────────

-- anon cannot read the base submission tables at all (no rows leak).
BEGIN;
SET LOCAL ROLE anon;
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM catune_submissions$sql$,
  0,
  'catune base table: anon SELECT returns 0 rows'
);
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM cadecon_submissions$sql$,
  0,
  'cadecon base table: anon SELECT returns 0 rows'
);
ROLLBACK;

-- A non-owner authenticated user cannot read another user's base-table rows.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM catune_submissions WHERE dataset_hash = 'hash-alice'$sql$,
  0,
  'catune base table: non-owner SELECT cannot see foreign row'
);
ROLLBACK;

-- The owner can still read their own base-table row (needed for insert-return).
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM catune_submissions WHERE dataset_hash = 'hash-alice'$sql$,
  1,
  'catune base table: owner SELECT sees own row'
);
ROLLBACK;

-- Community browsing still works: anon reads all rows through the public view.
BEGIN;
SET LOCAL ROLE anon;
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM catune_submissions_public WHERE dataset_hash = 'hash-alice'$sql$,
  1,
  'catune public view: anon can browse submissions'
);
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM cadecon_submissions_public WHERE dataset_hash = 'hash-alice'$sql$,
  1,
  'cadecon public view: anon can browse submissions'
);
ROLLBACK;

-- The public view must NOT expose the PII columns. Selecting them errors with
-- undefined_column (42703).
BEGIN;
SET LOCAL ROLE anon;
SELECT assert_denied(
  $sql$SELECT orcid FROM catune_submissions_public LIMIT 1$sql$,
  'catune public view omits orcid',
  '42703'
);
SELECT assert_denied(
  $sql$SELECT lab_name FROM catune_submissions_public LIMIT 1$sql$,
  'catune public view omits lab_name',
  '42703'
);
SELECT assert_denied(
  $sql$SELECT notes FROM cadecon_submissions_public LIMIT 1$sql$,
  'cadecon public view omits notes',
  '42703'
);
ROLLBACK;

-- ── public views are read-only (migration 011) ────────────────────────────

-- The *_public views run as their owner (security_invoker = false), so RLS on
-- the base tables does NOT apply to writes routed through them, and as
-- single-table projections Postgres treats them as auto-updatable. The only
-- thing preventing an anon-key holder from inserting forged rows or
-- rewriting/deleting every submission through a view is the privilege layer:
-- 011 revokes everything except SELECT. Every write must fail with 42501, for
-- both anon and an authenticated non-owner.
BEGIN;
DO $$
DECLARE
  who TEXT;
BEGIN
  FOREACH who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    PERFORM set_config(
      'request.jwt.claims',
      CASE who
        WHEN 'anon' THEN ''
        ELSE '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}'
      END,
      true
    );
    EXECUTE format('SET LOCAL ROLE %I', who);

    PERFORM assert_denied(
      $sql$
      INSERT INTO catune_submissions_public (
        user_id, tau_rise, tau_decay, t_peak, fwhm, lambda, sampling_rate,
        ar2_g1, ar2_g2, indicator, species, brain_region, dataset_hash, app_version
      ) VALUES (
        '11111111-1111-1111-1111-111111111111', 0.05, 0.4, 0.1, 0.3, 0.01, 30,
        0.9, -0.1, 'GCaMP6f', 'mouse', 'V1', 'hash-via-view', 'test'
      )
      $sql$,
      who || ': catune_submissions_public INSERT denied'
    );
    PERFORM assert_denied(
      $sql$UPDATE catune_submissions_public SET species = 'pwned' WHERE dataset_hash = 'hash-alice'$sql$,
      who || ': catune_submissions_public UPDATE denied'
    );
    PERFORM assert_denied(
      $sql$DELETE FROM catune_submissions_public WHERE dataset_hash = 'hash-alice'$sql$,
      who || ': catune_submissions_public DELETE denied'
    );

    PERFORM assert_denied(
      $sql$
      INSERT INTO cadecon_submissions_public (
        user_id, tau_rise, tau_decay, t_peak, fwhm, upsample_factor, sampling_rate,
        num_subsets, target_coverage, max_iterations, convergence_tol,
        num_iterations, converged, indicator, species, brain_region,
        dataset_hash, app_version
      ) VALUES (
        '11111111-1111-1111-1111-111111111111', 0.05, 0.4, 0.1, 0.3, 10, 30,
        4, 0.25, 20, 0.01, 10, true, 'GCaMP6f', 'mouse', 'V1',
        'hash-via-view', 'test'
      )
      $sql$,
      who || ': cadecon_submissions_public INSERT denied'
    );
    PERFORM assert_denied(
      $sql$UPDATE cadecon_submissions_public SET species = 'pwned' WHERE dataset_hash = 'hash-alice'$sql$,
      who || ': cadecon_submissions_public UPDATE denied'
    );
    PERFORM assert_denied(
      $sql$DELETE FROM cadecon_submissions_public WHERE dataset_hash = 'hash-alice'$sql$,
      who || ': cadecon_submissions_public DELETE denied'
    );

    RESET ROLE;
  END LOOP;
END
$$;

-- Belt-and-braces: the privilege catalogue must show SELECT as the only grant
-- anon/authenticated/PUBLIC hold on the views.
SELECT assert_row_count(
  $sql$
  SELECT COUNT(*)::int FROM information_schema.role_table_grants
  WHERE table_name IN ('catune_submissions_public', 'cadecon_submissions_public')
    AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    AND privilege_type <> 'SELECT'
  $sql$,
  0,
  'public views grant nothing but SELECT to anon/authenticated/PUBLIC'
);
ROLLBACK;

-- ── analytics_sessions: anon INSERT denied ─────────────────────────────────

BEGIN;
SET LOCAL ROLE anon;
SELECT assert_denied(
  $sql$
  INSERT INTO analytics_sessions (anonymous_id, user_id, is_anonymous, app_name)
  VALUES ('leak', '11111111-1111-1111-1111-111111111111', false, 'catune')
  $sql$,
  'analytics_sessions anon INSERT denied'
);
ROLLBACK;

-- ── analytics_sessions: direct INSERT denied even for own user_id (013) ───

-- Sessions are created only by the geo-session edge function (service_role),
-- so clients cannot choose country_code / region / is_anonymous / created_at.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_denied(
  $sql$
  INSERT INTO analytics_sessions (anonymous_id, user_id, is_anonymous, app_name, country_code)
  VALUES ('anon-alice-2', '11111111-1111-1111-1111-111111111111', false, 'catune', 'XX')
  $sql$,
  'analytics_sessions direct own INSERT denied'
);
ROLLBACK;

-- Same for an anonymous-auth visitor (the common case in production).
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","is_anonymous":true}';
SELECT assert_denied(
  $sql$
  INSERT INTO analytics_sessions (anonymous_id, user_id, is_anonymous, app_name)
  VALUES ('anon-visitor', '44444444-4444-4444-4444-444444444444', true, 'catune')
  $sql$,
  'analytics_sessions direct INSERT by anonymous-auth user denied'
);
ROLLBACK;

-- service_role (edge function) can still create sessions.
BEGIN;
SET LOCAL ROLE service_role;
SELECT assert_allowed(
  $sql$
  INSERT INTO analytics_sessions (anonymous_id, user_id, is_anonymous, app_name, country_code)
  VALUES ('edge-fn', '44444444-4444-4444-4444-444444444444', true, 'catune', 'US')
  $sql$,
  'analytics_sessions service_role INSERT allowed'
);
ROLLBACK;

-- ── analytics_sessions: column-scoped UPDATE of own row (013) ─────────────

-- ended_at / duration_seconds are the only client-writable columns.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_allowed(
  $sql$
  UPDATE analytics_sessions SET ended_at = now(), duration_seconds = 60
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  $sql$,
  'analytics_sessions own UPDATE of ended_at/duration_seconds'
);
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM analytics_sessions
      WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        AND ended_at IS NOT NULL AND duration_seconds = 60$sql$,
  1,
  'analytics_sessions own UPDATE lands'
);
ROLLBACK;

-- Every other column is denied at the privilege layer, even on own rows.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_denied(
  $sql$UPDATE analytics_sessions SET country_code = 'XX' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$sql$,
  'analytics_sessions own UPDATE of country_code denied'
);
SELECT assert_denied(
  $sql$UPDATE analytics_sessions SET is_anonymous = true WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$sql$,
  'analytics_sessions own UPDATE of is_anonymous denied'
);
SELECT assert_denied(
  $sql$UPDATE analytics_sessions SET user_id = '22222222-2222-2222-2222-222222222222' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$sql$,
  'analytics_sessions own UPDATE of user_id denied'
);
ROLLBACK;

-- ── analytics_sessions: INSERT forging foreign user_id denied ─────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
SELECT assert_denied(
  $sql$
  INSERT INTO analytics_sessions (anonymous_id, user_id, is_anonymous, app_name)
  VALUES ('forged', '11111111-1111-1111-1111-111111111111', false, 'catune')
  $sql$,
  'analytics_sessions INSERT forging foreign user_id'
);
ROLLBACK;

-- ── analytics_sessions: cross-user UPDATE filtered to zero rows ────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
-- Bob tries to mark Alice's session as ended. RLS filters out Alice's row
-- during USING, so the UPDATE affects 0 rows even though the session_id
-- reference is valid.
UPDATE analytics_sessions
  SET ended_at = now(), duration_seconds = 10
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM analytics_sessions
      WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        AND ended_at IS NOT NULL$sql$,
  0,
  'analytics_sessions cross-user UPDATE must not land'
);
ROLLBACK;

-- ── analytics_events: INSERT referencing a foreign session_id denied ──────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
SELECT assert_denied(
  $sql$
  INSERT INTO analytics_events (session_id, event_name, event_data)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'file_imported', '{}')
  $sql$,
  'analytics_events INSERT into foreign session denied'
);
ROLLBACK;

-- ── analytics_events: INSERT into own session allowed ─────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_allowed(
  $sql$
  INSERT INTO analytics_events (session_id, event_name, event_data)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'file_imported', '{}')
  $sql$,
  'analytics_events INSERT into own session'
);
ROLLBACK;

-- ── analytics_sessions: non-admin SELECT returns only own rows ────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM analytics_sessions$sql$,
  1,
  'analytics_sessions SELECT returns only own row for non-admin'
);
ROLLBACK;

-- ── analytics_sessions: admin SELECT sees everything ──────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","app_metadata":{"role":"admin"}}';
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM analytics_sessions$sql$,
  2,
  'analytics_sessions admin SELECT sees every row'
);
ROLLBACK;

-- ── field_options: anon INSERT denied ─────────────────────────────────────

BEGIN;
SET LOCAL ROLE anon;
SELECT assert_denied(
  $sql$INSERT INTO field_options (field_name, value) VALUES ('indicator', 'injected')$sql$,
  'field_options anon INSERT denied'
);
ROLLBACK;

-- ── field_options: public SELECT allowed ──────────────────────────────────

BEGIN;
SET LOCAL ROLE anon;
SELECT assert_allowed(
  $sql$SELECT * FROM field_options LIMIT 1$sql$,
  'field_options public SELECT'
);
ROLLBACK;

-- ── analytics_events data-size CHECK ──────────────────────────────────────

-- event_data capped at 4KB. Insert a 5KB blob as the session owner so the
-- RLS policy passes but the CHECK constraint rejects.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_denied(
  format(
    $fmt$
    INSERT INTO analytics_events (session_id, event_name, event_data)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'file_imported',
            jsonb_build_object('blob', %L))
    $fmt$,
    repeat('x', 5000)
  ),
  'analytics_events event_data > 4KB denied',
  '23514'
);
ROLLBACK;

-- ── analytics_sessions duration CHECK ─────────────────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
-- Sessions are only created by the edge function (013), so exercise the CHECK
-- through the one column-scoped UPDATE path clients still have.
SELECT assert_denied(
  $sql$
  UPDATE analytics_sessions SET duration_seconds = 100000
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  $sql$,
  'analytics_sessions duration > 86400 denied',
  '23514'
);
ROLLBACK;

-- ── catune tau bounds (post-009 tightening) ───────────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_denied(
  $sql$
  INSERT INTO catune_submissions (
    user_id, tau_rise, tau_decay, t_peak, fwhm, lambda, sampling_rate,
    ar2_g1, ar2_g2, indicator, species, brain_region, dataset_hash, app_version
  ) VALUES (
    '11111111-1111-1111-1111-111111111111', 0.8, 0.4, 0.1, 0.3, 0.01, 30,
    0.9, -0.1, 'GCaMP6f', 'mouse', 'V1', 'hash-tau-oob', 'test'
  )
  $sql$,
  'catune tau_rise > 0.5 denied',
  '23514'
);
ROLLBACK;

-- ── analytics_events: per-session cap (013) ───────────────────────────────

-- Seed 500 events (the cap) as the privileged test owner, then the owner's
-- next insert must be rejected with program_limit_exceeded (54000).
BEGIN;
INSERT INTO analytics_events (session_id, event_name, event_data)
SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'file_imported', '{}'
FROM generate_series(1, 499);
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_allowed(
  $sql$
  INSERT INTO analytics_events (session_id, event_name, event_data)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'file_imported', '{}')
  $sql$,
  'analytics_events 500th event in a session allowed'
);
SELECT assert_denied(
  $sql$
  INSERT INTO analytics_events (session_id, event_name, event_data)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'file_imported', '{}')
  $sql$,
  'analytics_events 501st event in a session denied',
  '54000'
);
-- Other sessions are unaffected by alice's cap.
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
SELECT assert_allowed(
  $sql$
  INSERT INTO analytics_events (session_id, event_name, event_data)
  VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'file_imported', '{}')
  $sql$,
  'analytics_events cap is per session'
);
ROLLBACK;

DO $$ BEGIN RAISE NOTICE 'ALL RLS ASSERTIONS PASSED'; END $$;
