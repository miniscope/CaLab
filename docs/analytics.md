# Usage analytics

CaLab apps send a small number of anonymous usage events through Supabase
(`analytics_sessions`, `analytics_events`). Code: `packages/community/src/analytics.ts`
(transport, opt-out in `analytics-consent.ts`, tester tag in `tester-tag.ts`) and
`apps/<app>/src/lib/analytics-integration.ts` (what each app reports). Analytics never
throws; a rejected insert is silent.

## What a session records

Random identifier (per browser tab, `sessionStorage`), app name and version, browser family,
screen size, referrer domain, country and region (resolved server-side by the `geo-session`
edge function; no IP address is stored). Start and end time.

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

| Event              | Fields                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file_imported`    | `extension` (e.g. `avi`; once per folder or multi-session plan, not live sources)                                                                                                                                                    |
| `run_started`      | `stage` (discover/refine/extract), `mode` (joint/separate/apply/single), `sessions`, `frames`, `fps`, `width`, `height`                                                                                                              |
| `run_finished`     | the same, plus `duration_s`, `median_fps`, `cells`, `peak_wasm_mb`                                                                                                                                                                   |
| `run_failed`       | `stage`, `error_category` (out_of_memory/webgpu/decode/worker/unknown), `error_type` (a closed list of error class names, e.g. RangeError), `peak_wasm_mb` (when known)                                                              |
| `boundary_summary` | `boundaries`, `ok`, `warning`, `failed` (once per finished or stopped Joint run)                                                                                                                                                     |
| `results_exported` | `sessions`, `format_version`                                                                                                                                                                                                         |
| `webgpu_info`      | `adapter` (hardware/fallback/none), `vendor`, `architecture`, `device`, `description` (each lowercase `[a-z0-9 ._-]`, at most 24/48/48/48 characters, omitted when empty), `max_buffer_mb`, `max_storage_mb` (WebGPU adapter limits) |
| `device_info`      | `os` (macos/windows/linux/chromeos/android/ios/other, family only), `cores`, `memory_gb` (`navigator.deviceMemory`, coarse, Chrome only), `browser_major`, `dpr` (rounded to 0.25); once per session                                 |
| `tester_tag`       | `tag` (opt-in, see below)                                                                                                                                                                                                            |

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
timezone, battery or IP address.

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

## Database migration

`supabase/migrations/017_analytics_event_name_shape.sql` replaces the fixed `event_name` list
(003) by the shape rule `^[a-z][a-z0-9_]{1,47}$`. **The project owner must run it.** Until it
runs, the new events are rejected silently by the old list; the client works in either order.
The 4096-byte `event_data` limit (008) fits every payload above and is unchanged.
