# Run record

Every saved result says how it was made. The run record is a versioned JSON
document (`format: "cala-run-record"`, `record_version: 2`) with the settings,
flags, versions, input, stages and machine of the run, enough to know exactly
what happened and to repeat it. Code: `src/lib/run-provenance.ts`.

## Where it is saved

- `meta_json.run_record` inside every `cala-export.npz` (single export, each
  session of an automatic run), and `run_record_json.npy` (a UTF-8 JSON byte
  vector) inside the CaDecon `.npz` export.
- Joint automatic runs: `cala-run-record.json` at the root of the results
  folder, rewritten with `cala-run.json`.
- Separate automatic runs: `cala-run-record.json` beside each session's
  results (each session is a run of its own; `input.session_index` says which),
  and none at the root.

The record is gathered when files are written. A Joint run writes the same
record into every session's export.
Nothing here is sent anywhere; no analytics field was added.

## Blocks

| Block                  | Contents                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `software`             | `app_version`, `git_commit` (the build's commit; null when unknown), `engine_version` (the WASM `cala_version()`; null if the module was not loaded)                                                                                                                                                                                                                                                                                 |
| `settings`             | every user-facing setting and its value, defaults included (see mapping below)                                                                                                                                                                                                                                                                                                                                                       |
| `tunables`             | the fixed engine constants that shape the run (`settle`, `csettle`, `governor`, `lookback`, `pacer`: `PACE_BATCH` and `PACE_SLACK`, `floor`: `FLOOR` and `TRACKER`)                                                                                                                                                                                                                                                                  |
| `url_flags`            | `debug`, each known flag present with its raw value and `in_effect` (debug-only flags are not in effect without `?debug`), and `other_flags` (names only). `?live=` is recorded as `(redacted)`.                                                                                                                                                                                                                                     |
| `input`                | label, live or file, frames, fps, size, bit depth, files (name, frames, size in bytes), sessions, mode                                                                                                                                                                                                                                                                                                                               |
| `stages`               | the stage log: Discover, Refine, Extract runs with `started_at`, `ended_at`, outcome, frames, cells                                                                                                                                                                                                                                                                                                                                  |
| `final_settle`         | `frames_fed`, `frames_planned`, `recording_frames`, `stopped_early_by_user`, `done`, `started_at`, `ended_at`                                                                                                                                                                                                                                                                                                                        |
| `target_speed.changes` | time-stamped list (`at`, `frame`, `fps`, `source`); `fps: 0` is Max (unpaced); the first entry is the speed at run start                                                                                                                                                                                                                                                                                                             |
| `work`                 | `cap` (the settle cap; 0 when Off), `cap_changes` (time-stamped `{at, frame, cap, source}`; the first entry is the cap at the run's start), `pool` (look-back workers in the run: 1 + the settle pool started), `visit_workers`, `achieved_fps` (Discover frames over its wall time), a `governor` summary (rate, limit, halvings, cap, achieved) when it ran, and `realised` (what the run did, as against what was set: see below) |
| `machine`              | `hardware_concurrency`, `device_memory_gb`, `platform`, `user_agent`, `gpu` (adapter vendor, architecture, device, description when WebGPU gives them), `webgpu`                                                                                                                                                                                                                                                                     |
| `slots`                | `slider_schedule`, `floor_estimate` (filled by the app), `curve_schedule` and `auto_decisions` (`null` until a curve or Auto run fills them; see below)                                                                                                                                                                                                                                                                              |

### Speed fields

- `settings.speed_mode`: `max`, `fixed`, `curve`, `auto` or `stream` (a live source). `settings.target_speed_fps` is the target at the end of setup (0: Max); what the run actually did is `target_speed.changes`, whose `source` says who changed it (`run start`, `setting`, `url`, `curve`, `auto`, ...).
- `work.realised` (null where a number is not known):

  | Field                            | Meaning                                                                                           |
  | -------------------------------- | ------------------------------------------------------------------------------------------------- |
  | `achieved_fps_mean`              | Discover's frames over its wall time                                                              |
  | `dose_per_live_frame`            | re-read frames Background settle delivered per Discover frame                                     |
  | `frames_missed_by_slow_loop`     | live frames the slow loop never observed                                                          |
  | `forward_drops`                  | frames the fast loop did not forward to the slow loop                                             |
  | `halvings`, `slow_halvings`      | the governor's halvings, and those a batch wait or a forward-pool drop caused                     |
  | `limit_shares`                   | share of about-one-second readings each governor limit held (sums to 1; empty without a governor) |
  | `pace_late_ms`, `pace_reanchors` | lateness the pacer dropped at re-anchors, and how often it re-anchored                            |
  | `max_fps_median`                 | median of the live Max estimate over the run                                                      |

- `slots.slider_schedule`: `{ scale: [10, 500], ladder: [...] }`, the Speed track and the floor's ladder the run was made with. The slider's position over the run is `target_speed.changes`.
- `slots.floor_estimate`: `{ start: { fps, confidence }, changes: [{ at, frame, fps, seeAllFps, limiting, confidence, terms }], last_inputs }`. `start` is the first value read (usually the prior, `confidence: "prior"`); each row of `changes` is a published (ladder) floor, which moves at most once per 15 s; `last_inputs` is what the raw estimate was last made from. `null` when the slow loop never reported. Lists past 2,000 rows are thinned (the oldest half keeps every second row).

No IP address, user identity or path outside the recording's own file names is
written.

## Extending

Fill a slot by passing `slots: { floor_estimate: {...} }` to `gatherRunRecord`
(or `RunRecordExtras.slots`); add fields under the slot. New top-level fields do
not need a version bump; bump `RUN_RECORD_VERSION` only when an existing field
changes meaning. Tell `RunTrace` about new time-stamped events the same way
`noteTargetSpeed` does.

## Reproducing from a record

A record maps to settings like this (`settingsFromRecord`):

| Record `settings` key         | Setting                                                                                                                                                           | URL flag                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `flat_field`                  | Sensor flat field                                                                                                                                                 | `?flatfield=0` turns it off |
| `discovery`                   | Discover on or off                                                                                                                                                |                             |
| `lookback`                    | Look-back                                                                                                                                                         | `?lookback`                 |
| `background_settle`           | Background settle: `auto-below-max` (the default under look-back: it runs whenever the target is below Max) or `off`                                              | `?csettle=0` turns it off   |
| `settle_cap`                  | the cap: 2, 1 or 0.5 re-read frames per live frame, or `off`                                                                                                      | `?csrate=`                  |
| `settle_yield_frames`         | frames per piece of an answer                                                                                                                                     | `?csettle=yieldN`           |
| `need_first`                  | one worker: need-driven look-back first                                                                                                                           | `?debug&needfirst`          |
| `lookback_pool`               | `planned_S` (the settle pool size of the page), `started_S` (the pool actually started: 0 for a run that stayed at Max), `started_at_frame` (null: never started) | `?debug&lbpool=` (S)        |
| `final_settle_level`          | Final settle: `thorough` (full pass), `standard` (87 %), `quick` (60 %)                                                                                           | the Final settle select     |
| `target_speed_fps`            | target speed (0: Max)                                                                                                                                             | `?debug&pacefps=`           |
| `smooth_playback`             | smooth playback                                                                                                                                                   | `?debug&smooth=0`           |
| `library_mode`, `refine_runs` | Joint or Separate, Refine runs (the session setup)                                                                                                                |                             |
| `extract_after_discover`      | "Extract after Discover" (Run tab)                                                                                                                                |                             |
| `export_pass_qc_only`         | export only cells that pass QC (Run tab)                                                                                                                          |                             |

With `?debug`, `__cala.applyRunRecord(recordOrJsonText)` re-applies the store
settings (everything with a URL flag above, plus flat field and Discover) before
the next Discover start and returns what it applied (null if it is not a run
record). Pool size (`?debug&lbpool=`) and the visit-worker count (`?visits=`) are
fixed when the page loads, so reload with the record's `url_flags` for those; when
the record's `lookback_pool.planned_S` differs from the page's, `applyRunRecord`
warns and returns the mismatch in `warnings`.

A record of a `curve` or `auto` run also gives `curve` (`settingsFromRecord`): its
realised `target_speed.changes` as `{ points: [{ at, fps }] }`, `at` the share of the
recording (0 to 1) and `fps` a number or `'max'`, repeats merged. A rerun that follows
this curve gets the same schedule whatever the machine decides. `speedMode` is returned
too, for information.

Version 1 records are still read: `settle_during_discover: false` is the cap Off,
`true` Background settle as now (the default) at the recorded
`settle_ceiling_per_live_frame`; `settle_governor` is ignored (the governor is the
only dose rule since version 2). The
session setup settings (`library_mode`, `refine_runs`) are chosen in the setup
screen. `__cala.runRecord()` returns the record of the run so far.
