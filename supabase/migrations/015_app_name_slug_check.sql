-- Validate analytics_sessions.app_name by shape instead of a list of apps.
--
-- Problem: 003 and 007 constrained app_name with `CHECK (app_name IN (...))`.
-- Every new web app had its analytics silently rejected at the database
-- (initSession swallows the geo-session 500) until someone remembered to
-- write a migration widening the list.
--
-- Fix: replace the list with the slug rule every app's `calab.id` must follow
-- (lowercase letter, then 1-31 of [a-z0-9_-]). The same pattern is enforced
-- by packages/vite-config (APP_ID_PATTERN, at build time) and the geo-session
-- edge function (APP_NAME_PATTERN, per request); keep the three in sync.
-- The edge function is the only writer (013), so this is defence in depth
-- against garbage, not an allowlist.
--
-- Existing rows ('catune', 'carank', 'cadecon') all satisfy the new rule, so
-- the constraint is added validated.
--
-- Idempotent: both the old and the new constraint are dropped IF EXISTS
-- before the new one is (re)created.

BEGIN;

ALTER TABLE analytics_sessions
  DROP CONSTRAINT IF EXISTS analytics_sessions_app_name_check;

ALTER TABLE analytics_sessions
  DROP CONSTRAINT IF EXISTS analytics_sessions_app_name_slug_check;

ALTER TABLE analytics_sessions
  ADD CONSTRAINT analytics_sessions_app_name_slug_check
  CHECK (app_name ~ '^[a-z][a-z0-9_-]{1,31}$');

COMMIT;
