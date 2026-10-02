-- Require a real (non-anonymous) sign-in to submit community parameters.
--
-- Problem: every app calls `initSession()` at load, which calls
-- `supabase.auth.signInAnonymously()` so analytics writes carry a verified
-- JWT (see 008). Anonymous-auth users get the `authenticated` database role,
-- and the submission INSERT policies (001 "Authenticated users can submit",
-- 006 "Auth insert") only checked `auth.uid() = user_id`. So every visitor
-- could post community submissions without ever entering an email, which
-- defeats the magic-link gate and makes spam/poisoning trivial.
--
-- Fix: the INSERT policies additionally require the JWT's `is_anonymous`
-- claim to be false. Supabase sets `is_anonymous: true` on tokens issued by
-- `signInAnonymously()`; a missing claim (older tokens, service tooling) is
-- treated as not anonymous. DELETE policies are unchanged — an anonymous
-- user can no longer own a submission, and existing owners keep delete.
--
-- Idempotent: each policy is dropped (IF EXISTS) and recreated.

BEGIN;

DROP POLICY IF EXISTS "Authenticated users can submit" ON catune_submissions;

CREATE POLICY "Authenticated users can submit"
ON catune_submissions FOR INSERT
TO authenticated
WITH CHECK (
  (select auth.uid()) = user_id
  AND coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

DROP POLICY IF EXISTS "Auth insert" ON cadecon_submissions;

CREATE POLICY "Auth insert"
ON cadecon_submissions FOR INSERT
TO authenticated
WITH CHECK (
  (select auth.uid()) = user_id
  AND coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

COMMIT;
