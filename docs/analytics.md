# Usage analytics

CaLab apps send a small number of anonymous usage events through Supabase
(`analytics_sessions`, `analytics_events`). Code: `packages/community/src/analytics.ts`
(transport, opt-out in `analytics-consent.ts`, tester tag in `tester-tag.ts`) and
`apps/<app>/src/lib/analytics-integration.ts` (what each app reports). Analytics never
throws; a rejected insert is silent.

## What a session records

Random identifier (per browser tab, `sessionStorage`), app name and version, browser family,
screen size, referrer domain, country and region (resolved server-side by the `geo-session`
edge function, which sends the visitor's IP once, over HTTPS, to a geolocation service,
ipwho.is with geojs.io as a backup, and keeps only the country and region; CaLab never stores
or logs the IP address). Start and end time.

## Opting out

- Switch in Cala (start screen, "Share anonymous usage statistics") and on the landing page
  footer. Both write `localStorage['calab_analytics_off']` (`'1'` off, `'0'` explicitly on).
- Browsers sending Do Not Track (`navigator.doNotTrack === '1'`) are off by default unless the
  user switched statistics on.
- When off, no session is created, no anonymous sign-in happens and no request is made.

## Cala events

Every payload is filtered through an allowlist (`ALLOWED_FIELDS` in Cala's integration) and
covered by a test. Volume is one event per stage run, export or session; the database caps a
session at 500 events (migration 013).

| Event              | Fields                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_opened`   | `sessions` (sessions in the project: 1 for a single recording or a live stream), `live` (a live stream), `existing` (its `calab-project.json` was already there); once per open                                                                                                                                                                                                                |
| `file_imported`    | `extension` (e.g. `avi`; once per recording opened or plan step run, not live sources)                                                                                                                                                                                                                                                                                                         |
| `run_started`      | `stage` (discover/extract; older versions also sent refine), `mode` (joint/separate/apply: the plan step's kind; a single recording and a live stream are a Separate step of one; older versions sent single), `sessions` (sessions this run processes: Joint all of the step's, Separate 1), `plan_sessions` (size of the step, once its run has started), `frames`, `fps`, `width`, `height` |
| `run_finished`     | the same, plus `duration_s`, `median_fps`, `cells`, `peak_wasm_mb`                                                                                                                                                                                                                                                                                                                             |
| `run_failed`       | `stage`, `error_category` (out_of_memory/webgpu/decode/worker/unknown), `error_type` (a closed list of error class names, e.g. RangeError), `peak_wasm_mb` (when known)                                                                                                                                                                                                                        |
| `boundary_summary` | `boundaries`, `ok`, `warning`, `failed` (once per finished or stopped Joint run)                                                                                                                                                                                                                                                                                                               |
| `results_exported` | `sessions`, `format_version` (once per run that wrote results, and per export by hand)                                                                                                                                                                                                                                                                                                         |
| `webgpu_info`      | `adapter` (hardware/fallback/none), `vendor`, `architecture`, `device`, `description` (each lowercase `[a-z0-9 ._-]`, at most 24/48/48/48 characters, omitted when empty), `max_buffer_mb`, `max_storage_mb` (WebGPU adapter limits)                                                                                                                                                           |
| `device_info`      | `os` (macos/windows/linux/chromeos/android/ios/other, family only), `cores`, `memory_gb` (`navigator.deviceMemory`, coarse, Chrome only), `browser_major`, `dpr` (rounded to 0.25); once per session                                                                                                                                                                                           |
| `tester_tag`       | `tag` (opt-in, see below)                                                                                                                                                                                                                                                                                                                                                                      |

Chaining is tracked apart from plan size: a Joint plan is one run per stage over all its sessions
(`sessions` = the plan size), a Separate plan is one run per stage per session (`sessions` = 1,
`plan_sessions` = how many sessions the plan has). Summing `sessions` over finished runs gives the
sessions processed per stage. Events sent before this change carry the plan's size in `sessions` in every
mode and no `plan_sessions`; the Admin app reads a Separate or single run as one
session whichever version sent it. Versions that still had the Refine stage also sent `refine_runs`
(Refine runs a plan asked for before Extract, 0 to 5); the Refine stage and that field were removed
and the app no longer sends them. The server still accepts both from older versions.

### Memory fields

- `peak_wasm_mb`: the largest sampled (every 2 s) sum of WASM linear memory over the main
  thread and every worker (solver, visit, flat-field, trace, compress, review). Each worker
  reports its heap size over a same-origin `BroadcastChannel` every 2 s
  (`apps/cala/src/lib/memory-telemetry.ts`); a worker silent for 30 s is dropped. Peak of the
  sum at sample times, so short spikes between samples are missed. All browsers.
- Not reported: a JS-heap figure. `performance.memory.usedJSHeapSize` (Chrome and Edge only)
  sees the main thread alone (about 200 MB of a 2.4 GB tab in a real run) and workers have
  none, so it would look reassuring while the memory is elsewhere. Worker JS heaps and
  ArrayBuffers (where the v2.18.0 regression lived) and GPU memory are invisible to a page
  without cross-origin isolation, so `peak_wasm_mb` is not the tab's total footprint.
- `peak_wasm_mb` is also sent on `run_failed` when known.

`device_info` and the extra `webgpu_info` fields are a coarse hardware snapshot, sent once per
session: no user agent string, OS version, canvas/WebGL/audio fingerprint, fonts, languages,
timezone or battery, and no IP address is kept.

Shared events used by other apps: `demo_loaded`, `auth_signed_in/out`, `tutorial_*`,
`community_browser_opened` and so on (`AnalyticsEventName`).

## Optional tester tag

Off and empty by default. A beta tester may type a name in Cala's statistics section
(`localStorage['calab_tester_tag']`); letters, digits, space and `. _ @ -` only, at most 32
characters (anything else is stripped). It is sent as one `tester_tag` event `{tag}` at the
start of a session and whenever it changes, and only while statistics are on. It is the only
user-typed value in any event, is not added to other events and is not linked to a signed-in
account; the Admin app joins it to runs by `session_id`. Clearing the box stops sending it.

## Never collected

File or folder names, paths, animal or session names, trace or footprint data, error stacks,
recording timestamps, anything else the user typed (except the optional tag). Error message
text is never sent, only a category and, when it matches a closed list, the error class name.

## Local builds send nothing

Analytics is only enabled in builds that have the Supabase environment (`VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`, set by the deploy workflow). A local build (`npm run dev`, `npm run build`
without those variables) has no Supabase client, so it creates no session and sends no events.
Runs from local or dev builds therefore never appear in Admin; if a lab member's local runs are
missing from the counts, this is why. Only the deployed site is counted (plus any build that was
given the credentials, which Admin hides under "Include dev builds" when its version is `dev`).

## Database migration

`supabase/migrations/017_analytics_event_name_shape.sql` replaces the fixed `event_name` list
(003) by the shape rule `^[a-z][a-z0-9_]{1,47}$`. **The project owner must run it.** Until it
runs, the new events are rejected silently by the old list; the client works in either order.
The 4096-byte `event_data` limit (008) fits every payload above and is unchanged.

## Admin app

`apps/admin` (hidden from the app list, admin role only: RLS limits `analytics_*` reads to
`app_metadata.role = 'admin'`). Reads use keyset pagination (1000 rows per page, newest first, 30 s timeout and one retry per page). Sessions and submissions load first and events stream in afterwards (current period only), so views render immediately and show an "events still loading" note. Row caps: 100k sessions, 150k events; a banner appears when a table hits one. Sessions and events are read with `select('*')`: columns the database lacks (for example `is_anonymous`, migration 008) are listed in a banner and the related metric shows n/a. No database migration
is required: aggregation is client-side (the optional `018_analytics_admin_read_performance.sql` adds indexes for the keyset reads and a cheaper admin RLS expression). The Overview tab ends with a read-only **Schema status** panel that reports which migrations the live database has applied (via the optional `019_schema_fingerprint.sql`; "unknown" when it is not installed; see `supabase/README.md`). Filters live in the URL hash
(`#/cala?app=cala&range=90d&ver=2.18.1&dev=1`).

### Definitions

- **Browser**: a distinct `user_id`. Supabase anonymous auth persists per browser profile
  (localStorage), so this is per browser, not per person, and resets when site data is cleared.
  `anonymous_id` is per tab and is not used for counting. Sessions without `user_id` (pre-008)
  are counted as sessions only.
- **Signed-in account**: distinct non-anonymous `user_id`. No account identity is shown; users
  appear only as six-character hashes.
- **Returning**: a browser with sessions on more than one UTC day in the range. New vs returning
  and cohorts use "first seen in the loaded data", so with a short range early visits are
  invisible; choose All for true first-seen.
- **Median session**: `ended_at - created_at` (heartbeat), else `duration_seconds`; over 4 h is
  dropped (a tab left open).
- **Dates** are UTC throughout; weeks start Monday. The previous period is the equal-length
  period before the range (none for All).
- **Dev noise**: version `dev` and localhost-like referrers are hidden unless "Include dev builds".
- Events are attributed to an app through their session; events whose session started before
  the loaded range are not attributed (a note shows how many).

### Reading the Cala tab

- **Funnel**: sessions with at least one of each event, each step capped by the previous.
- **Failure rate**: `run_failed / (run_finished + run_failed)`.
- **Unfinished runs**: `run_started` with no later `run_finished` or `run_failed` of the same
  stage in the same session (a finish closes the most recent open start of its stage). It is the
  only trace of a tab killed by an out-of-memory condition, but it is also a closed or reloaded
  tab or a run the user stopped (cancelled runs emit nothing), so read it as a rate and look for
  version-to-version jumps. "Survived" is the session's last heartbeat minus the run start
  (accurate to about a minute).
- **Median fps**: median of per-run `median_fps`; the headline uses hardware adapters only so
  software rendering does not hide a regression, and "fps by adapter class" shows it separately.
- **Version comparison** ignores the version filter and flags a version whose GPU median fps
  fell more than 20%, or whose failure or unfinished rate rose more than 10 or 15 points, against
  the previous version with at least 5 attempts.
- **Hardware** (needs `device_info` and the extended `webgpu_info`; older versions are
  "Unknown"): mixes of OS, cores, memory class, GPU vendor and architecture, browser and major
  version, and fps and failure rates grouped by GPU class, cores, memory, max buffer size and OS.
  Groups with fewer than 3 run starts are hidden unless "Show small groups" is on.
  `peak_wasm_mb` is a main-thread figure in older versions and a sum over threads in newer ones.
- **Testers**: tags are free text typed by users and are rendered as plain text; a session's
  last `tester_tag` is joined to its runs by `session_id`.

### Fixture mode

`npm run dev -w apps/admin`, then open `http://localhost:<port>/?fixture=1`. It bypasses both
Supabase and the admin gate and shows seeded synthetic data (all apps, several Cala versions
with a simulated 2.18.0 regression and a high unfinished rate, hardware events from 2.19.0,
testers, returning browsers). The flag requires `import.meta.env.DEV`, which is the literal
`false` in a build, so the generator is not in the production bundle; a test builds the app and
checks this.
