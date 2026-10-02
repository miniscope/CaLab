-- Route analytics session creation exclusively through the geo-session edge
-- function and narrow what clients can change afterwards.
--
-- Problem: 008 still let any `authenticated` caller (which includes every
-- anonymous-auth visitor) INSERT `analytics_sessions` rows directly and pick
-- `country_code`, `region`, `is_anonymous`, `created_at`, `app_version`, ...
-- — the very fields the edge function is supposed to resolve server-side. The
-- UPDATE policy allowed rewriting every column of the caller's own rows, and
-- nothing bounded how many events one session could append.
--
-- Fix:
--   1. Drop the authenticated INSERT policy and the INSERT grant. The
--      geo-session edge function inserts with the service_role key, which
--      bypasses RLS and keeps working. The client (packages/community
--      analytics.ts) never inserts sessions directly; if the edge function
--      fails, analytics are simply skipped for that page load.
--   2. Column-level UPDATE: authenticated users may only touch `ended_at` and
--      `duration_seconds` (heartbeat / pagehide), and only on their own rows
--      (row policy re-asserted below).
--   3. Cap events per session with a cheap BEFORE INSERT trigger (index scan
--      on idx_events_session_id, stops counting at the cap). Concurrent
--      inserts can overshoot by a handful — it is an abuse bound, not an
--      exact quota.
--
-- Idempotent: REVOKE/GRANT are no-ops when already applied; policies and the
-- trigger are dropped IF EXISTS and recreated.

BEGIN;

-- 1. No direct session inserts from API roles.
DROP POLICY IF EXISTS "Users insert own sessions" ON analytics_sessions;
REVOKE INSERT ON analytics_sessions FROM anon, authenticated;

-- 2. Column-scoped updates of own rows only.
REVOKE UPDATE ON analytics_sessions FROM anon, authenticated;
GRANT UPDATE (ended_at, duration_seconds) ON analytics_sessions TO authenticated;

DROP POLICY IF EXISTS "Users update own sessions" ON analytics_sessions;
CREATE POLICY "Users update own sessions"
  ON analytics_sessions FOR UPDATE
  TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- 3. Per-session event cap.
CREATE OR REPLACE FUNCTION public.analytics_events_enforce_session_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY DEFINER so the count sees every event row: non-admin callers have
-- no SELECT policy on analytics_events and would otherwise always count 0.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_events CONSTANT INTEGER := 500;
  existing INTEGER;
BEGIN
  SELECT count(*) INTO existing
  FROM (
    SELECT 1 FROM public.analytics_events
    WHERE session_id = NEW.session_id
    LIMIT max_events
  ) capped;

  IF existing >= max_events THEN
    RAISE EXCEPTION 'analytics session % exceeded % events', NEW.session_id, max_events
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  RETURN NEW;
END
$$;

-- Trigger functions cannot be invoked via RPC, but don't leave it EXECUTE-able
-- by the API roles anyway (Supabase's default privileges grant it).
REVOKE ALL ON FUNCTION public.analytics_events_enforce_session_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS analytics_events_session_cap ON analytics_events;
CREATE TRIGGER analytics_events_session_cap
  BEFORE INSERT ON analytics_events
  FOR EACH ROW
  EXECUTE FUNCTION public.analytics_events_enforce_session_cap();

COMMIT;
