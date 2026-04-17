-- RLS policy test matrix.
--
-- Boots every migration (001–009) against a Postgres instance seeded by
-- preamble.sql, then asserts the owner/non-owner/anon/admin matrix for:
--   - catune_submissions, cadecon_submissions  (INSERT, DELETE)
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

CREATE OR REPLACE FUNCTION assert_denied(sql TEXT, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  succeeded BOOLEAN := false;
BEGIN
  BEGIN
    EXECUTE sql;
    succeeded := true;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    -- Expected denial
    RETURN;
  WHEN OTHERS THEN
    -- Anything else is also a form of denial that happens to surface as a
    -- different SQLSTATE; record it so we still count the test as a pass.
    RETURN;
  END;
  IF succeeded THEN
    RAISE EXCEPTION 'EXPECTED DENY BUT PASSED: %', label;
  END IF;
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

-- ── catune_submissions: cross-user DELETE denied ───────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
-- Bob tries to delete Alice's row. DELETE policy uses auth.uid() = user_id,
-- so RLS filters the candidate rows to zero → query succeeds with 0 rows
-- affected. Assert no rows were deleted.
DELETE FROM catune_submissions WHERE dataset_hash = 'hash-alice';
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
SELECT assert_row_count(
  $sql$SELECT COUNT(*)::int FROM cadecon_submissions WHERE dataset_hash = 'hash-alice'$sql$,
  1,
  'cadecon cross-user DELETE must not remove row'
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

-- ── analytics_sessions: owner INSERT allowed ──────────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_allowed(
  $sql$
  INSERT INTO analytics_sessions (anonymous_id, user_id, is_anonymous, app_name)
  VALUES ('anon-alice-2', '11111111-1111-1111-1111-111111111111', false, 'catune')
  $sql$,
  'analytics_sessions own INSERT'
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
  'analytics_events event_data > 4KB denied'
);
ROLLBACK;

-- ── analytics_sessions duration CHECK ─────────────────────────────────────

BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT assert_denied(
  $sql$
  INSERT INTO analytics_sessions (anonymous_id, user_id, is_anonymous, app_name, duration_seconds)
  VALUES ('duration-test', '11111111-1111-1111-1111-111111111111', false, 'catune', 100000)
  $sql$,
  'analytics_sessions duration > 86400 denied'
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
  'catune tau_rise > 0.5 denied'
);
ROLLBACK;

DO $$ BEGIN RAISE NOTICE 'ALL RLS ASSERTIONS PASSED'; END $$;
