-- Make the Admin app's analytics reads cheap. Optional: the app works without
-- this migration (it degrades to slower reads), but run it for large tables.
--
-- The Admin dashboard reads analytics_sessions and analytics_events with keyset
-- pagination: WHERE created_at in a window AND (created_at, id) < cursor,
-- ORDER BY created_at DESC, id DESC, LIMIT 1000.
--
-- 1. Composite indexes matching that order, so each page is an index range scan
--    with no sort (003 only indexed created_at alone, leaving the id tiebreak to
--    an extra sort step).
-- 2. The admin SELECT policies (003) call auth.jwt() per row. Wrapping it in a
--    sub-select makes Postgres evaluate it once per statement (the "initplan"
--    pattern 010 already uses for auth.uid()). Same condition, same access.
--
-- Idempotent. Run by the project owner (SQL editor). Index creation briefly
-- blocks writes to the two tables while it builds.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_sessions_created_at_id
  ON analytics_sessions (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_events_created_at_id
  ON analytics_events (created_at DESC, id DESC);

DROP POLICY IF EXISTS "Admins can read sessions" ON analytics_sessions;
CREATE POLICY "Admins can read sessions"
  ON analytics_sessions FOR SELECT
  TO authenticated
  USING (((select auth.jwt())->'app_metadata'->>'role') = 'admin');

DROP POLICY IF EXISTS "Admins can read events" ON analytics_events;
CREATE POLICY "Admins can read events"
  ON analytics_events FOR SELECT
  TO authenticated
  USING (((select auth.jwt())->'app_metadata'->>'role') = 'admin');

COMMIT;
