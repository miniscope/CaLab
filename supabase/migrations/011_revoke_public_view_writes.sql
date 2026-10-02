-- Make the community *_public views read-only at the privilege layer.
--
-- Problem: migration 010 created `catune_submissions_public` and
-- `cadecon_submissions_public` with `security_invoker = false`, so queries
-- through them run with the view OWNER's privileges and RLS on the base tables
-- is bypassed (the owner is exempt from its own tables' RLS). Both views are
-- single-table column projections with no aggregates/DISTINCT/LIMIT, so
-- Postgres treats them as automatically updatable: INSERT/UPDATE/DELETE on the
-- view are rewritten onto the base table, still as the owner.
--
-- 010 only added `GRANT SELECT`, but a stock Supabase project also runs
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON TABLES TO anon, authenticated, service_role;
-- which applies to views too. Net effect: anyone holding the public anon key
-- could INSERT rows with a forged `user_id`, UPDATE any submission, or DELETE
-- every submission through the view, bypassing every RLS policy.
--
-- Fix: revoke everything on the views from the API roles and PUBLIC, then
-- re-grant SELECT only. Without INSERT/UPDATE/DELETE privilege the statement
-- fails with 42501 before the view rewrite ever runs.
--
-- Why not something else:
--   * `security_barrier` only constrains predicate push-down; the view stays
--     auto-updatable.
--   * A trivial `WHERE true` does not stop a view from being auto-updatable.
--   * An INSTEAD OF trigger that raises would work, but it is extra code that
--     only fires once the caller already holds write privilege; the REVOKE
--     is the actual control and is what Supabase's advisor checks for.
--   * `security_invoker = true` would apply base-table RLS, which (post-010)
--     hides other contributors' rows and so breaks community browsing.
--
-- Idempotent: REVOKE/GRANT are no-ops when already in the target state.

BEGIN;

REVOKE ALL ON catune_submissions_public FROM anon, authenticated, PUBLIC;
REVOKE ALL ON cadecon_submissions_public FROM anon, authenticated, PUBLIC;

GRANT SELECT ON catune_submissions_public TO anon, authenticated;
GRANT SELECT ON cadecon_submissions_public TO anon, authenticated;

COMMIT;
