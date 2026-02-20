# Supabase Database Setup

CaLab uses [Supabase](https://supabase.com/) for community parameter sharing.
We do **not** use the Supabase CLI — all migrations are applied manually via the
Supabase Dashboard SQL Editor.

## Table structure

Each CaLab app has its own submissions table (e.g., `catune_submissions`).
All tables share a common set of base columns defined in `000_base_template.sql`.

- `000_base_template.sql` — **template only** (not executed). Copy and extend for new apps.
- `001_catune_submissions.sql` — CaTune submissions table with deconvolution-specific columns.
- `002_field_options.sql` — shared canonical field options lookup table.

## Applying migrations

1. Open your Supabase project dashboard.
2. Navigate to **SQL Editor**.
3. Run each numbered file in order:
   - `001_catune_submissions.sql` — CaTune submissions table, RLS policies, and indexes
   - `002_field_options.sql` — canonical field options lookup table
4. Run `supabase/seed/field_options_seed.sql` to populate the indicator, species, and brain region lookup values.

## Adding a new app

1. Copy `000_base_template.sql` and replace `<app>` with your app name.
2. Add app-specific columns in the marked section.
3. Run the new migration in Supabase SQL Editor.

## Seed data

`seed/field_options_seed.sql` uses `ON CONFLICT DO NOTHING`, so it is safe to
re-run without duplicating rows.

## Environment variables

Set these in your `.env` file (see `.env.example` at the repo root):

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```
