-- Minimal Supabase auth scaffolding so every migration applies cleanly
-- against a vanilla Postgres instance. Mirrors just enough of Supabase's
-- `auth` schema and role system for RLS policies to compile and execute
-- correctly.
--
-- Not intended for production — tests only.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  raw_app_meta_data JSONB DEFAULT '{}'::jsonb,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `auth.uid()` returns the caller's user id from the current_setting.
-- Tests set `request.jwt.claims` via `set_config` to switch identity.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- `auth.jwt()` returns the current claims JSON so `is_admin()` and the
-- anonymous-flag check can read them.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb
$$;

-- Supabase ships two database roles that RLS policies reference.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO anon, authenticated, service_role;

-- Mirror Supabase's default public-schema grants EXACTLY. A stock Supabase
-- project runs (as `postgres` / `supabase_admin`):
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON TABLES    TO anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
--
-- so every new table AND VIEW in `public` is fully writable by `anon` at the
-- privilege layer, and RLS is the only thing standing in the way. An earlier
-- version of this preamble granted anon SELECT only, which hid the fact that
-- the security-definer `*_public` views (migration 010) were writable by
-- anyone holding the anon key (fixed in 011). Keep this faithful: a harness
-- that is stricter than production gives false confidence.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
