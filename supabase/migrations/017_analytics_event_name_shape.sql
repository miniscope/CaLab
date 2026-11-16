-- Validate analytics_events.event_name by shape instead of a list of events.
--
-- Problem: 003 constrained event_name with `CHECK (event_name IN (...))`.
-- Every new tracked event (Cala's run_started, run_finished, ...) would be
-- silently rejected at the database (trackEvent swallows the insert error)
-- until someone wrote a migration widening the list.
--
-- Fix: replace the list with a shape rule (lowercase letter, then 1-47 of
-- [a-z0-9_]). The client union `AnalyticsEventName` in
-- packages/community/src/analytics.ts is the source of truth for the names;
-- this is defence in depth against garbage, like 015 for app_name. Volume is
-- bounded by 013's per-session cap and payload size by 008's 4096-byte
-- event_data check (the largest Cala payload is well under 1 KB), so neither
-- changes.
--
-- Existing rows (file_imported, demo_loaded, parameters_submitted,
-- snapshot_pinned, community_browser_opened, submission_created,
-- ranking_completed, tutorial_started, tutorial_completed, auth_signed_in,
-- auth_signed_out) all satisfy the new rule, so the constraint is added
-- validated.
--
-- THE PI MUST RUN THIS MIGRATION on the Supabase project. Deploy order does
-- not matter: before it runs, the new events are rejected silently by the old
-- list (analytics never throws); after it runs, they are accepted.
--
-- Idempotent: both the old and the new constraint are dropped IF EXISTS
-- before the new one is (re)created.

BEGIN;

ALTER TABLE analytics_events
  DROP CONSTRAINT IF EXISTS analytics_events_event_name_check;

ALTER TABLE analytics_events
  DROP CONSTRAINT IF EXISTS analytics_events_event_name_shape_check;

ALTER TABLE analytics_events
  ADD CONSTRAINT analytics_events_event_name_shape_check
  CHECK (event_name ~ '^[a-z][a-z0-9_]{1,47}$');

COMMIT;
