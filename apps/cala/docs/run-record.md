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
| `tunables`             | the fixed engine constants that shape the run (`settle`, `csettle`, `governor`, `lookback`, `pacer`: `PACE_BATCH` and `PACE_SLACK`, `floor`: `FLOOR` and `TRACKER`); `settle.maxFrames` and look-back's `jointUpdate`, `jointSign`, `mergeGuardMinSep`, `rate` and `maxFrames` are the run's engine values from its params (null before a run)                                                                                       |
| `params`               | the run's resolved params (`apps/cala/src/lib/run-params.ts`): `fingerprint` (SHA-256 of the fields that change results), `context` (`fps`: the recording's or the 20 fps fallback, `frame`) and `values` (every `CalaParams` field); absent before the first run                                                                                                                                                                    |
| `url_flags`            | `debug`, each known flag present with its raw value and `in_effect` (whether the app's own reading of the value changes the run: debug-only flags are not in effect without `?debug`, and no-op values such as `gpu=1` are not in effect), and `other_flags` (names only). `?live=` is recorded as `(redacted)`.                                                                                                                     |
| `input`                | label, live or file, frames, fps, size, bit depth, files (name, frames, size in bytes), sessions, mode                                                                                                                                                                                                                                                                                                                               |
| `stages`               | the stage log: Discover and Extract runs (a record from before Refine was removed may also list `refine` runs) with `started_at`, `ended_at`, outcome, frames, cells                                                                                                                                                                                                                                                                 |
| `final_settle`         | `frames_fed`, `frames_planned`, `recording_frames`, `stopped_early_by_user`, `done`, `started_at`, `ended_at`                                                                                                                                                                                                                                                                                                                        |
| `target_speed.changes` | time-stamped list (`at`, `frame`, `fps`, `source`); `fps: 0` is Max (unpaced); the first entry is the speed at run start                                                                                                                                                                                                                                                                                                             |
| `work`                 | `cap` (the settle cap; 0 when Off), `cap_changes` (time-stamped `{at, frame, cap, source}`; the first entry is the cap at the run's start), `pool` (look-back workers in the run: 1 + the settle pool started), `visit_workers`, `achieved_fps` (Discover frames over its wall time), a `governor` summary (rate, limit, halvings, cap, achieved) when it ran, and `realised` (what the run did, as against what was set: see below) |
| `machine`              | `hardware_concurrency`, `device_memory_gb`, `platform`, `user_agent`, `gpu` (adapter vendor, architecture, device, description when WebGPU gives them), `webgpu`                                                                                                                                                                                                                                                                     |
| `slots`                | `slider_schedule`, `floor_estimate` (filled by the app), `curve_schedule`, `auto_decisions` and `auto_extra_time_share` (`null` until a curve or Auto run fills them; see below)                                                                                                                                                                                                                                                     |

### Speed fields

- `settings.speed_mode`: `max`, `fixed`, `curve`, `auto` or `stream` (a live source). `settings.target_speed_fps` is the target at the start of the run (0: Max; `settings.settle_cap` is likewise the cap at the start); what the run actually did is `target_speed.changes`, whose `source` says who changed it (`run start`, `setting`, `url`, `curve`, `auto`, ...).
- `work.realised` (null where a number is not known). The counts are read from the slow worker about once a second during Discover's own run and kept, so a Refine or Extract that follows does not change them (the last second of Discover may be missing). `achieved_fps_mean` is the whole Discover stage's frames over its wall time, pauses and the Final settle included:

  | Field                            | Meaning                                                                                           |
  | -------------------------------- | ------------------------------------------------------------------------------------------------- |
  | `achieved_fps_mean`              | Discover's frames over its wall time                                                              |
  | `dose_per_live_frame`            | re-read frames Background settle delivered per Discover frame                                     |
  | `frames_missed_by_slow_loop`     | live frames the slow loop never observed                                                          |
  | `forward_drops`                  | frames the fast loop did not forward to the slow loop                                             |
  | `halvings`, `slow_halvings`      | halvings of the settle dose; 0 (the dose is counted per live frame and does not back off)         |
  | `limit_shares`                   | share of about-one-second readings each governor limit held (sums to 1; empty without a governor) |
  | `pace_late_ms`, `pace_reanchors` | lateness the pacer dropped at re-anchors, and how often it re-anchored                            |
  | `max_fps_median`                 | median of the live Max estimate over the run (with the visit rate on, what the visits allow)      |
  | `fast_max_fps_median`            | median of the fast loop's own top speed (same as `max_fps_median` with the visit rate off)        |

- `work.visit_rate` (null when the run was not a Discover run): the Discover visit rate ([stages.md](stages.md#discovers-visit-rate)). `mode` is `on` (recording: cap and floor/target), `cap-only` (live stream) or `off` (`?debug&visitrate=off`); `schedule` is `fixed` (the default) or `auto` (`?debug&visitrate=auto`; null when off); `schedule_params` are the engine's (`{ auto, target, steps, full_yield, slow_half_life_visits, fast_half_life_visits, warmup_visits_per_tile, cap_ratio, floor, hold_floor_ratio }`, `discover/visitrate.rs`; null when none was reported); `floor`, `target` and `cap` are the fixed rate's bounds, Auto's top (visits per frame; `cap` 0 when off); `target_now` and `target_min` the target in force at the last reading and the lowest it reached; `target_frames` the frames read at each target (`{ target, frames }`); `target_changes` (`{ frame, target, yield_slow, yield_fast }`, frames read, the yields in new cells per visit; at most 200, then `target_changes_dropped` counts the rest); `new_cells`, `yield_slow` and `yield_fast` at the last reading; `achieved_visits_per_frame` is Discover's ordinary visits over the frames it read (dropped batches included) and `achieved_visits_per_observed_frame` over the frames the slow loop observed; `visits`, `frames_read`, `frames_observed`; `capped_frames`, the frames on which the cap held a due visit back; `held_s`, the run time the hold slowed the run, and `min_hold_fps`, its lowest value (null: never held); `below_floor_s`, the run time the 1 s windowed rate sat below the floor; `hold_changes` (`{ frame, fps, achieved, reason }`, `fps` null when released, `reason` one of `below-target`, `below-floor`, `raised`, `released`; at most 200, then `hold_changes_dropped` counts the rest). Read about once a second during Discover, the last time when Discover reads its last frame.
- `slots.slider_schedule`: `{ scale: [10, 500], ladder: [...] }`, the Speed track and the floor's ladder the run was made with. The slider's position over the run is `target_speed.changes`.
- `slots.curve_schedule`: set when the run followed a speed curve (Curve mode), else `null`: `{ preset, points, effective_points, armed_at_frame }`. `points` is the curve as set (`at` the share of the recording, 0 to 1; `fps` a number, `"max"`, `"floor"` for the live smart floor or `"seeAll"` for the rate below which the slow loop sees every frame); `effective_points` is what ran, with steps shorter than 20 s plus twice the Background settle's climb (cap x fps / 8 s) merged into their neighbour (a Max step is never merged); `preset` is `find-fast`, `step-down`, `custom` or `replay`. The steps the driver took are in `target_speed.changes` with `source: "curve"`.
- `slots.auto_extra_time_share` and `slots.auto_decisions`: set when the run was in Auto mode, else `null`. Auto is a time budget: `auto_extra_time_share` is the extra time over a Max run's Discover time the user chose (the Final settle comes on top of it) (0.5, 1 or 2: +50, +100 or +200 %). `auto_decisions` lists each change of target Auto made, newest last, at most 40 (the first is always kept; older ones after it are dropped): `{ frame, fps, reason, max_fps, left_s }`, `fps` the new target (0: Max), `reason` one of `budget` (the rate that ends the run at the budget), `floor` (the budget allowed less than the smart floor, so it sat at the floor), `max` (the budget needs Max or more, or the floor is at Max) or `over budget`; `max_fps` is the Max rate it worked from and `left_s` the seconds the budget had left for the remaining frames. Auto looks again every 2,000 frames or 30 s, never goes below the floor, and ignores a new target within 15 % of the one in force. The targets themselves are in `target_speed.changes` with `source: "auto"`; a run that starts in Auto is at Max until the Max rate is measured over five batches; that measure is kept while paced and only rises. Paused time does not count against the budget. The record keeps Auto's slots even if the Speed setting is changed after the run.
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

| Record `settings` key    | Setting                                                                                                                                                           | URL flag                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `flat_field`             | Sensor flat field                                                                                                                                                 | `?flatfield=0` turns it off |
| `discovery`              | Discover on or off                                                                                                                                                |                             |
| `lookback_ran`           | Look-back actually ran in this run (the setting can be on while a live stream blocks it; a Joint run has it)                                                      |                             |
| `lookback`               | Look-back                                                                                                                                                         | `?lookback=0` (off)         |
| `background_settle`      | Background settle: `auto-below-max` (the default under look-back: it runs whenever the target is below Max) or `off`                                              | `?csettle=0` turns it off   |
| `settle_cap`             | the cap at the start: 2, 1 or 0.5 re-read frames per live frame, or `off` (changes: `work.cap_changes`)                                                           | `?csrate=`                  |
| `settle_yield_frames`    | frames per piece of an answer                                                                                                                                     | `?csettle=yieldN`           |
| `need_first`             | one worker: need-driven look-back first                                                                                                                           | `?debug&needfirst`          |
| `repeatable`             | repeatable run: at a target speed, results apply at batch barriers and libraries at stamped frames (live streams: `false`)                                        | `?debug&repeatable=0` (off) |
| `lookback_pool`          | `planned_S` (the settle pool size of the page), `started_S` (the pool actually started: 0 for a run that stayed at Max), `started_at_frame` (null: never started) | `?debug&lbpool=` (S)        |
| `final_settle_level`     | Final settle: `thorough` (full pass), `standard` (87 %), `quick` (60 %)                                                                                           | the Final settle select     |
| `target_speed_fps`       | target speed at the start of the run (0: Max)                                                                                                                     | `?debug&pacefps=`           |
| `smooth_playback`        | smooth playback                                                                                                                                                   | `?debug&smooth=0`           |
| `library_mode`           | Joint or Separate (the session setup)                                                                                                                             |                             |
| `extract_after_discover` | "Extract after Discover" (Run tab)                                                                                                                                |                             |
| `export_pass_qc_only`    | export only cells that pass QC (Run tab)                                                                                                                          |                             |

With `?debug`, `__cala.applyRunRecord(recordOrJsonText)` re-applies the store
settings (everything with a URL flag above, plus flat field and Discover) before
the next Discover start and returns what it applied (null if it is not a run
record). Pool size (`?debug&lbpool=`) and the visit-worker count (`?visits=`) are
fixed when the page loads, so reload with the record's `url_flags` for those; when
the record's `lookback_pool.planned_S` differs from the page's, `applyRunRecord`
warns and returns the mismatch in `warnings`.

`?debug&detlog` (measurement only, changes no decision) keeps the slow worker's
determinism log on the page (`__calaDetlog`, `src/lib/detlog.ts`): one row per batch,
visit take and apply, library published, look-back request and answer, each stamped
with the live frames observed so far. `scripts/memory-measure.mjs --detlog` saves it as
`<tag>-detlog.json`, and `scripts/detlog-diff.mjs a.json b.json` names where two runs
first differ. It is listed in `url_flags` like the other flags.

A record of a `curve` or `auto` run also gives `curve` (`settingsFromRecord`): its
realised `target_speed.changes` as `{ points: [{ at, fps }] }`, `at` the share of the
recording (0 to 1) and `fps` a number or `'max'`, repeats merged. With `?debug`,
`__cala.applyRunRecord` starts the Speed block's Curve mode with exactly those steps (not
merged or cut: a replayed curve runs as recorded) after the record's target, so a rerun
follows the same schedule whatever the machine decides. `speedMode` is returned too, for
information.

Version 1 records are still read: `settle_during_discover: false` is the cap Off,
`true` Background settle as now (the default) at the recorded
`settle_ceiling_per_live_frame`; `settle_governor` is ignored (the governor is the
only dose rule since version 2). The
session setup setting (`library_mode`) is chosen in the setup
screen. Records from before Refine was removed also hold `refine_runs` (the Refine runs the plan asked for); it is no longer written. `__cala.runRecord()` returns the record of the run so far.
