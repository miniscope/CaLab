# Supabase Database Setup

CaLab uses [Supabase](https://supabase.com/) for community parameter sharing,
usage analytics, and admin moderation.

## Table structure

Each CaLab app has its own submissions table (e.g., `catune_submissions`).
All tables share a common set of base columns defined in `000_base_template.sql`.

| Migration                    | Purpose                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `000_base_template.sql`      | **Template only** (not executed). Copy and extend for new apps.                 |
| `001_catune_submissions.sql` | CaTune submissions table with deconvolution-specific columns.                   |
| `002_field_options.sql`      | Shared canonical field options lookup table.                                    |
| `003_analytics.sql`          | Analytics tables (`analytics_sessions`, `analytics_events`) for usage tracking. |
| `004_admin_role.sql`         | `is_admin()` helper function and admin moderation policies.                     |

## Applying migrations

1. Open your Supabase project dashboard.
2. Navigate to **SQL Editor**.
3. Run each numbered file in order (001 through 004).
4. Run `supabase/seed/field_options_seed.sql` to populate the indicator, species, and brain region lookup values.

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
/tmp/supabase functions deploy geo-session --project-ref <your-project-ref>
```

On macOS with Homebrew:

```bash
brew install supabase/tap/supabase
supabase login
supabase functions deploy geo-session --project-ref <your-project-ref>
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

Analytics collects: anonymous session ID (per-tab), country/region (resolved server-side from IP, IP is never stored), browser family, screen dimensions, referrer domain, app name/version, and allow-listed event names.

**Not stored:** IP addresses, full user agent strings, full referrer URLs, file contents or names, persistent cross-session identifiers.
