-- Tighten analytics RLS (CRIT-2).
--
-- The 003 policies let any anon caller with the publishable key forge
-- `user_id`, inject events against any `session_id`, and mutate any session
-- row by UUID. This migration:
--
-- 1. Adds an `is_anonymous` column so the admin UI can still distinguish
--    anonymous visitors from logged-in users now that every session carries
--    a `user_id` (anon or real).
-- 2. Adds data-integrity CHECK constraints (duration bounds, ended_at
--    ordering, event_data size cap) that were missing.
-- 3. Replaces the permissive policies with ownership-based ones keyed to
--    `auth.uid()`. Writes require a signed-in user (anonymous or real) so
--    the JWT identifies the owner.
--
-- Client flow after this migration: the client calls
-- `supabase.auth.signInAnonymously()` before `initSession`, then all writes
-- carry a verified JWT whose `sub` matches the session's `user_id`.

-- 1. is_anonymous column.
-- Backfill: before this migration, the pre-existing "anonymous" sessions
-- were the ones with `user_id IS NULL`. New-schema anon sessions will
-- carry an anonymous-auth user id, so we default the column to true and
-- then flip pre-existing logged-in sessions to false.
ALTER TABLE analytics_sessions
  ADD COLUMN is_anonymous BOOLEAN NOT NULL DEFAULT true;

UPDATE analytics_sessions
  SET is_anonymous = false
  WHERE user_id IS NOT NULL;

-- 2. CHECK constraints
ALTER TABLE analytics_sessions
  ADD CONSTRAINT analytics_sessions_ended_at_order_check
    CHECK (ended_at IS NULL OR ended_at >= created_at);

ALTER TABLE analytics_sessions
  ADD CONSTRAINT analytics_sessions_duration_bounds_check
    CHECK (
      duration_seconds IS NULL
      OR (duration_seconds >= 0 AND duration_seconds <= 86400)
    );

-- Event payloads are intentionally free-form JSON but should not be used as
-- free storage. 4 KB is enough for any legitimate high-level event.
ALTER TABLE analytics_events
  ADD CONSTRAINT analytics_events_event_data_size_check
    CHECK (length(event_data::text) <= 4096);

-- 3. Replace permissive policies with ownership-based ones.
DROP POLICY IF EXISTS "Anyone can insert sessions" ON analytics_sessions;
DROP POLICY IF EXISTS "Anyone can update session end" ON analytics_sessions;
DROP POLICY IF EXISTS "Anyone can insert events" ON analytics_events;

-- Sessions: caller's auth.uid() must match the inserted/updated row.
-- `authenticated` in Supabase includes both real users and anonymous
-- sign-in users — both paths get a verified JWT.
CREATE POLICY "Users insert own sessions"
  ON analytics_sessions FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own sessions"
  ON analytics_sessions FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Callers can read their own session rows. Needed so the events INSERT
-- policy's EXISTS subquery (below) can see the caller's session — RLS
-- subqueries run with the caller's privileges, so without this policy
-- the subquery would find nothing and the events INSERT would be denied
-- for everyone except admins.
CREATE POLICY "Users read own sessions"
  ON analytics_sessions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Events: session_id must reference a session the caller owns.
CREATE POLICY "Users insert events for own sessions"
  ON analytics_events FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM analytics_sessions
      WHERE analytics_sessions.id = analytics_events.session_id
        AND analytics_sessions.user_id = auth.uid()
    )
  );

-- 4. Revoke any lingering anon-role writes. RLS already blocks anon
-- (no `TO anon` policy exists), but revoking the table-level grants
-- makes the intent explicit and belts-and-suspenders against a future
-- accidental `CREATE POLICY ... TO anon`.
REVOKE INSERT, UPDATE ON analytics_sessions FROM anon;
REVOKE INSERT ON analytics_events FROM anon;
