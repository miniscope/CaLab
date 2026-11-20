# Supabase Database Setup

CaLab uses [Supabase](https://supabase.com/) for community parameter sharing,
usage analytics, and admin moderation.

## Table structure

Each CaLab app has its own submissions table (e.g., `catune_submissions`).
All tables share a common set of base columns defined in `000_base_template.sql`.

| Migration                                  | Purpose                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `000_base_template.sql`                    | **Template only** (not executed). Copy and extend for new apps.                                                            |
| `001_catune_submissions.sql`               | CaTune submissions table with deconvolution-specific columns.                                                              |
| `002_field_options.sql`                    | Shared canonical field options lookup table.                                                                               |
| `003_analytics.sql`                        | Analytics tables (`analytics_sessions`, `analytics_events`) for usage tracking.                                            |
| `004_admin_role.sql`                       | `is_admin()` helper function and admin moderation policies.                                                                |
| `005`–`009`                                | CaDecon table, bridge data source, analytics hardening, and tighter constraints.                                           |
| `010_restrict_submission_pii.sql`          | Locks submission reads to owner+admin; adds PII-free `*_public` browsing views.                                            |
| `011_revoke_public_view_writes.sql`        | Makes the `*_public` views SELECT-only for `anon`/`authenticated` (no writes through the views).                           |
| `012_block_anonymous_submissions.sql`      | Submission INSERT requires a real (non-anonymous) sign-in.                                                                 |
| `013_lock_analytics_writes.sql`            | Sessions created only by the edge function; clients may update only `ended_at`/`duration_seconds`; per-session event cap.  |
| `014_validate_submission_payloads.sql`     | Length/range/finite CHECKs on every submission column (added `NOT VALID`; validate after cleanup).                         |
| `015_app_name_slug_check.sql`              | Validates `analytics_sessions.app_name` by slug shape instead of a fixed app list.                                         |
| `016_cadecon_max_firing_rate.sql`          | CaDecon `max_firing_rate` NOT NULL (0 < x <= 10000, finite) replaces the dropped `upsample_factor`; public view recreated. |
| `017_analytics_event_name_shape.sql`       | Validates `analytics_events.event_name` by shape (`^[a-z][a-z0-9_]{1,47}$`) instead of a fixed list.                       |
| `018_analytics_admin_read_performance.sql` | **Optional.** Indexes and a cheaper admin RLS expression for the Admin app's keyset reads.                                 |
| `019_schema_fingerprint.sql`               | **Optional.** `schema_fingerprint()`: read-only, admin-only jsonb of booleans for the Admin "Schema status" panel.         |

## Applying migrations

1. Open your Supabase project dashboard.
2. Navigate to **SQL Editor**.
3. Run each numbered file in order (001 through the highest-numbered). Existing
   projects only need to run migrations they have not applied yet.
4. Run `supabase/seed/field_options_seed.sql` to populate the indicator, species, and brain region lookup values.

> **Note:** migration `010` must be applied **before** deploying the app build
> that reads the `*_public` views, or community browsing will fail until the
> views exist.

## Checking what production has applied

Production migrations are applied **by hand** in the SQL editor and there is no
`supabase_migrations` table, so a skipped file is invisible until something breaks
(008 and 015 were once skipped, which broke Admin and rejected `cala` sessions).

The Admin app's Overview tab has a read-only **Schema status** panel. It calls
`public.schema_fingerprint()` (migration `019`, **the project owner must apply it by hand**, once;
until then the panel shows "unknown" and the rest of the dashboard is unaffected). The function is
admin-only (`app_metadata.role = 'admin'`), `SECURITY DEFINER`, modifies nothing and returns only
booleans. Expected result on a fully migrated database: **every key below is `true`**. The same
keys are listed in `apps/admin/src/lib/fingerprint.ts`; keep the migration, that file and this
table in sync when a migration adds objects.

| Migration | Key                                 | True when present                                                   |
| --------- | ----------------------------------- | ------------------------------------------------------------------- |
| 003       | `003_analytics_tables`              | `analytics_sessions` and `analytics_events` exist                   |
| 004       | `004_is_admin_function`             | `is_admin()` exists                                                 |
| 006       | `006_cadecon_table`                 | `cadecon_submissions` exists                                        |
| 008       | `008_is_anonymous_column`           | `analytics_sessions.is_anonymous`                                   |
| 008       | `008_event_data_size_check`         | constraint `analytics_events_event_data_size_check`                 |
| 008       | `008_session_time_checks`           | `..._ended_at_order_check` and `..._duration_bounds_check`          |
| 008       | `008_permissive_policies_removed`   | the three "Anyone can ..." policies are gone                        |
| 008       | `008_events_insert_policy`          | policy "Users insert events for own sessions"                       |
| 009       | `009_catune_tau_bounds`             | `valid_tau_decay` carries the 0.01 lower bound                      |
| 010       | `010_public_views`                  | `catune_submissions_public`, `cadecon_submissions_public`           |
| 010       | `010_owner_read_policy`             | policy "Owner and admin read access" on `catune_submissions`        |
| 011       | `011_views_select_only`             | `anon` has no INSERT/UPDATE/DELETE on the `*_public` views          |
| 012       | `012_no_anonymous_submissions`      | submit policy checks `is_anonymous`                                 |
| 013       | `013_session_cap_trigger`           | trigger `analytics_events_session_cap`                              |
| 013       | `013_client_session_insert_removed` | policy "Users insert own sessions" is gone                          |
| 014       | `014_payload_checks`                | constraint `valid_indicator_len` on `catune_submissions`            |
| 015       | `015_app_name_slug_check`           | constraint `analytics_sessions_app_name_slug_check`                 |
| 016       | `016_cadecon_max_firing_rate`       | `max_firing_rate` present, `upsample_factor` gone                   |
| 017       | `017_event_name_shape_check`        | constraint `analytics_events_event_name_shape_check`                |
| 018       | `018_admin_read_indexes`            | `idx_sessions_created_at_id`, `idx_events_created_at_id` (optional) |

Without 019, run the same checks by hand in the SQL editor (read-only), for example for the
two that were skipped:

```sql
select
  exists(select 1 from information_schema.columns where table_schema='public'
         and table_name='analytics_sessions' and column_name='is_anonymous') as m008_is_anonymous,
  exists(select 1 from pg_constraint
         where conname='analytics_sessions_app_name_slug_check') as m015_app_name_slug;
```

The Admin app itself reads analytics tables with `select('*')` and never names a column an older
schema may lack, so a missing column degrades a metric to "n/a" instead of failing the page.

## Edge Functions

CaLab uses one Edge Function for server-side GeoIP resolution during analytics session creation.

### Deploying the Edge Function

You need the Supabase CLI. On Linux/WSL:

```bash
# Download the CLI binary
curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz | tar xz -C /tmp

# Log in (opens browser for access token)
/tmp/supabase login

# Deploy from the repo root
cd /path/to/CaTune
/tmp/supabase functions deploy geo-session --no-verify-jwt --project-ref <your-project-ref>
```

On macOS with Homebrew:

```bash
brew install supabase/tap/supabase
supabase login
supabase functions deploy geo-session --no-verify-jwt --project-ref <your-project-ref>
```

Your project ref is the subdomain in your Supabase URL (e.g., `abcdefghijk` from `https://abcdefghijk.supabase.co`).

The Edge Function uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` which Supabase auto-injects — no extra configuration needed.

## Admin role setup

The admin dashboard requires `app_metadata.role = 'admin'` on the user's auth record.

To grant admin access via the Supabase Dashboard:

1. Go to **Authentication** > **Users**.
2. Find the user, click the **three dots** menu > **Edit User**.
3. In the **App Metadata** field, set or merge: `{"role": "admin"}`
4. Click **Save**.
5. The user must **sign out and sign back in** for the JWT to include the new role.

## Adding a new app

1. Copy `000_base_template.sql` and replace `<app>` with your app name.
2. Add app-specific columns in the marked section.
3. Run the new migration in Supabase SQL Editor.

## Seed data

`seed/field_options_seed.sql` uses `ON CONFLICT DO NOTHING`, so it is safe to
re-run without duplicating rows.

## Environment variables

Set these in your `.env` file at the repo root (used by Vite during development):

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

For GitHub Pages deployment, these are set as repository secrets:

- `SUPABASE_URL` → mapped to `VITE_SUPABASE_URL` in the deploy workflow
- `SUPABASE_ANON_KEY` → mapped to `VITE_SUPABASE_ANON_KEY` in the deploy workflow

Community features gracefully degrade when credentials are not configured — the apps work fully offline.

## Privacy

Analytics collects: anonymous session ID (per-tab), country/region (resolved server-side: the `geo-session` function sends the IP once over HTTPS to a geolocation service, ipwho.is with geojs.io as a backup, and never stores or logs it; Supabase's gateway does not forward a country header), browser family, screen dimensions, referrer domain, app name/version, and event names (lowercase slugs, validated by shape since migration 017).

**Not stored:** IP addresses, full user agent strings, full referrer URLs, file contents or names, persistent cross-session identifiers.
