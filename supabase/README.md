# Supabase Database Setup

CaTune uses [Supabase](https://supabase.com/) for community parameter sharing.
We do **not** use the Supabase CLI — all migrations are applied manually via the
Supabase Dashboard SQL Editor.

## Applying migrations

1. Open your Supabase project dashboard.
2. Navigate to **SQL Editor**.
3. Run each file in `supabase/migrations/` in numeric order:
   - `001_community_submissions.sql` — submissions table, RLS policies, and indexes
   - `002_field_options.sql` — canonical field options lookup table
4. Run `supabase/seed/field_options_seed.sql` to populate the indicator, species, and brain region lookup values.

## Seed data

`seed/field_options_seed.sql` uses `ON CONFLICT DO NOTHING`, so it is safe to
re-run without duplicating rows.

## Environment variables

Set these in your `.env` file (see `.env.example`):

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```
