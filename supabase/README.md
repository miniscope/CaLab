# Supabase Database Setup

CaLab uses [Supabase](https://supabase.com/) for community parameter sharing,
usage analytics, and admin moderation.

## Table structure

Each CaLab app has its own submissions table (e.g., `catune_submissions`).
All tables share a common set of base columns defined in `000_base_template.sql`.

| Migration                              | Purpose                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `000_base_template.sql`                | **Template only** (not executed). Copy and extend for new apps.                                                            |
| `001_catune_submissions.sql`           | CaTune submissions table with deconvolution-specific columns.                                                              |
| `002_field_options.sql`                | Shared canonical field options lookup table.                                                                               |
| `003_analytics.sql`                    | Analytics tables (`analytics_sessions`, `analytics_events`) for usage tracking.                                            |
| `004_admin_role.sql`                   | `is_admin()` helper function and admin moderation policies.                                                                |
| `005`–`009`                            | CaDecon table, bridge data source, analytics hardening, and tighter constraints.                                           |
| `010_restrict_submission_pii.sql`      | Locks submission reads to owner+admin; adds PII-free `*_public` browsing views.                                            |
| `011_revoke_public_view_writes.sql`    | Makes the `*_public` views SELECT-only for `anon`/`authenticated` (no writes through the views).                           |
| `012_block_anonymous_submissions.sql`  | Submission INSERT requires a real (non-anonymous) sign-in.                                                                 |
| `013_lock_analytics_writes.sql`        | Sessions created only by the edge function; clients may update only `ended_at`/`duration_seconds`; per-session event cap.  |
| `014_validate_submission_payloads.sql` | Length/range/finite CHECKs on every submission column (added `NOT VALID`; validate after cleanup).                         |
| `015_app_name_slug_check.sql`          | Validates `analytics_sessions.app_name` by slug shape instead of a fixed app list.                                         |
| `016_cadecon_max_firing_rate.sql`      | CaDecon `max_firing_rate` NOT NULL (0 < x <= 10000, finite) replaces the dropped `upsample_factor`; public view recreated. |
| `019_cala_donations.sql`               | `cala_donations` for raw data donations: owner/admin read, writes only via the `donation` Edge Function.                   |

## Applying migrations

1. Open your Supabase project dashboard.
2. Navigate to **SQL Editor**.
3. Run each numbered file in order (001 through the highest-numbered). Existing
   projects only need to run migrations they have not applied yet.
4. Run `supabase/seed/field_options_seed.sql` to populate the indicator, species, and brain region lookup values.

> **Note:** migration `010` must be applied **before** deploying the app build
> that reads the `*_public` views, or community browsing will fail until the
> views exist.

## Edge Functions

CaLab uses two Edge Functions:

- `geo-session`: server-side GeoIP resolution during analytics session creation.
- `donation`: the backend for raw data donations from cala (see below).

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

### `donation` Edge Function

Backend for raw data donations (`apps/cala/docs/data-donation.md`). It is the
only writer of `cala_donations` (migration `019` must be applied first) and the
only holder of the R2 keys: browsers and the lab server get presigned URLs.
Donor and admin actions verify the caller's Supabase session themselves; lab
ingest uses the `x-ingest-token` header instead of a JWT, so deploy without
gateway JWT verification:

```bash
supabase functions deploy donation --no-verify-jwt --project-ref <your-project-ref>
supabase secrets set --project-ref <your-project-ref> \
  R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... \
  INGEST_TOKEN="$(openssl rand -hex 32)"
```

| Secret                                                                   | Purpose                                                                                                                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 bucket via the S3 API (key needs object read/write on that bucket).                                                                  |
| `INGEST_TOKEN`                                                           | Shared secret of the lab-server ingest job (at least 32 characters; ingest is disabled without it).                                                |
| `DONATION_MAX_BYTES`                                                     | Optional. Per-donation cap in bytes (default 10 GiB).                                                                                              |
| `DONATION_GLOBAL_CAP_BYTES`                                              | Optional. Cap on bytes declared by donations still in the bucket (default 200 GiB).                                                                |
| `DONATION_MAX_OPEN_PER_USER`                                             | Optional. Donations per user not yet ingested/rejected/withdrawn (default 2).                                                                      |
| `DONATION_STALE_HOURS`                                                   | Optional. An upload unfinished after this many hours is withdrawn and its files deleted (default 48).                                              |
| `RESEND_API_KEY`, `DONATION_NOTIFY_EMAILS`                               | Optional. Email (via Resend) to these comma-separated addresses when a donation finishes uploading. Both needed; failures never fail the donation. |
| `DONATION_NOTIFY_FROM`, `DONATION_ADMIN_URL`                             | Optional. Sender (default `onboarding@resend.dev`, which only delivers to the Resend account's own address) and a review link in the email.        |
| `DONATION_EXTRA_ORIGINS`                                                 | Optional. Comma-separated extra CORS origins (e.g. preview deploys).                                                                               |

Bucket setup: a CORS rule allowing `PUT` and `GET` from the app origins (the
browser uploads straight to R2), and a lifecycle rule that expires objects
under `pending/` after a few weeks (abandoned uploads). Tests:
`cd supabase/functions/donation && deno test --allow-env --allow-net index.test.ts`.

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
