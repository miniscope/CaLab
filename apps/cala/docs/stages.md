# Run stages: Discover, Extract

A cala run is made of named stages. They replace the older "pass 1 / pass 2".
The names are the same in the UI, the export metadata (`meta_json.stages`), the
run's event log and these docs.

There used to be a third stage, **Refine**, which replayed the recording from
frame 0 so footprints could keep converging. It was removed: Discover for a
recording now runs with **look-back** (re-reads earlier frames for each new
cell) and ends with the **Final settle** (Thorough by default), which lets the
footprints converge with the cell set frozen. Evaluation showed that gives
better footprints (fewer bites and less crosstalk, fewer false cells, the same
true cells) than Discover + Refine: `tools/cala-eval/results/2026-11-22-beta-gate.md`
and `tools/cala-eval/results/2026-11-22-settle-size.md`. Results and run records saved
before the removal may still list `refine` stage runs; they load, and the
Refine runs show as "Refine (removed stage)".

| Stage        | What it does                                                                                                                                                                                                                            | Streaming | Recording                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| **Discover** | Finds cells and builds their footprints from an empty library, with live traces. Every edit is allowed: adds, absorbs, splits, merges, keep tests and deletions. For a recording it runs with look-back and ends with the Final settle. | yes       | yes (first)                                                   |
| **Extract**  | Solves the final traces of every frame with the footprints frozen.                                                                                                                                                                      | no        | after Discover; once at the end, again if the library changed |

## Discover's visit rate

Discover's slow loop refines the model tile by tile ("visits"). How many visits it
makes per frame sets how many cells it finds and, at high rates, how many false
cells it adds; footprint and trace quality do not move
(`tools/cala-eval/results/2026-11-24-visit-budget-sweep.md`). The rate used to be
whatever time was spare: about 0.2 visits per frame at Max (the cell-model worker
saturated) and about 4.7 paced at 30 fps, so the result depended on the machine and
the Speed setting. Discover now keeps it fixed (`src/lib/visit-rate.ts`, constants in
`VISIT_RATE`; provisional, being confirmed on full-length motion sims and real data):

| Bound  | Visits per frame | Where                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cap    |              1.0 | in the slow loop (`crates/cala/src/discover/visitrate.rs`): ordinary visits are handed out against a credit that grows by 1.0 per observed Discover frame (banked at most 16 frames' worth, not banked while nothing is due). It covers every ordinary visit, whatever made its tile due (live frames, look-back frames, edits nearby); settle visits, the Final settle and Refine-scope visits are not held. Recordings and live streams. |
| target |              0.4 | the governor (`VisitRateGovernor`): every 2 s of run time it compares the visits per frame **read** with the target; when they fall behind while tiles are due and the cap is not what limits them, it holds the frame loop to the speed at which the measured visit throughput meets the target (down at once, up by at most 25 % per window, released once the hold no longer binds). Recordings only.                                   |
| floor  |              0.2 | below it the hold is cut a further 25 % so the run catches up. Recordings only: a live stream cannot slow down, so it keeps the cap only.                                                                                                                                                                                                                                                                                                  |

The hold combines with the Speed setting: the frame loop gets the lower of the two
(Max, Fixed, Curve and Auto keep their own target; the hold only lowers it). The
Speed block says when the hold binds ("Held at N fps to keep refinement at 0.4
visits/frame"), and the run log gets an entry each time it moves. Background settle
is told the user's target, not the hold, so a held Max run does not start it.

The floor and target count visits per frame **read** (dropped batches included), the
cap per frame observed. At Max the fast loop drops batches for the slow loop (about
25 % of the frames on the 3k sim); counted per observed frame, dropping frames would
itself meet the rate, and a run that drops more would visit less over the same
recording, which is the speed dependence this removes. The run record keeps the
bounds and what the run achieved (`work.visit_rate`, [run-record.md](run-record.md)).
`?debug&visitrate=off` restores the behaviour before (no cap, no hold); qc_eval's
`--visit-rate R` sets the same cap.

## Order

- Extract runs only after Discover has finished and the slow loop has
  published its final library, which comes after the Final settle
  (`stageAvailability` in `src/lib/run-stages.ts`).
- One replay runs at a time: no Discover restart while Extract runs.
- **Look-back and the Final settle** are on by default for recordings (the
  "Look-back refinement" checkbox and the "Final settle" level, Thorough, in
  the Run panel; `?lookback=0` turns look-back off). They need a recording on
  disk (one session, or a Joint run of several) and the pipelined workers.
  Where they cannot run (a live stream, `?pipeline=0`) the panel says why, and
  the footprints get no refinement after Discover.
- **Extract after Discover** (on by default for recordings) starts Extract
  when Discover finishes (its Final settle included). Turn it off to inspect
  the footprints first; the panel then shows the Extract button with the hint
  "Extract to solve the final traces with the settled footprints."
  The option is not saved between sessions.
- A new Discover run (Restart) starts the stage log over.
- **Streaming runs Discover only.** A live source has no file to replay, and
  cala does no live re-processing. Save the stream and load it later as a
  recording to Extract it.

## What carries over from Discover to Extract

- **Library.** The fast loop solves with Discover's final library from frame 0.
- **Motion.** Replayed from Discover's record (`RunRecord`). There is no
  re-registration.
- **Flicker.** Replayed from the record.
- **Flat field.** Discover's newest map is applied from frame 0. It gets no
  more updates.
- **Noise map and preprocessor state.** Rebuilt by the replay from the
  calibrated state.
- **Not carried over.** The fast loop's trace-solver warm start: the replay
  builds a new engine. QC is not run during Extract; the QC columns of the
  export come from Discover's last snapshot, then are recomputed from the
  extracted traces.

## Per-stage readout

The stage log (`createStageLog`) records each run: stage, index, start and end
time, outcome, frames, cells and library version. The stages add their own
counts:

- **Discover:** adds, merges, deletes, splits and refines (the slow loop's
  counters).
- **Extract:** frames and cells.

The export's `meta_json.stages` holds the same records (format version 3). Exports from before Refine was removed may also hold `refine` runs with footprint-change fields (`footprints_refined`, `median_footprint_change`, `change_p90`, `refined_share`, `series`); readers ignore those fields.

## Correlation vs distance

The Correlation tab (`components/CorrDistancePanel.tsx`, math in
`lib/corr-distance.ts`) plots the median Pearson r of cell-trace pairs against their
centre distance, a ground-truth-free check for incomplete demixing. Traces are
high-passed with a 15 s centred moving average; D is the median equivalent diameter at
half maximum of the footprints; bins are <0.5, 0.5-0.75, 0.75-1, 1-1.25, 1.25-1.5, 1.5-2, 2-3 and 3-6 D, each shown as median and IQR at its median pair distance, and the dotted line is the median over the 1.5-3 D pairs. Beside them is a canvas scatter of the individual pairs (continuous x, 0-6 D; points outside the fixed y range are counted, not drawn). Pairs: every pair within 6 D, the plotted range, for the stats and the scatter alike; only above 400,000 pairs is each kept with the same probability at every distance, so the density stays continuous (the note under the plot says so). Pairs beyond 6 D are not used. It runs on demand in a worker (`workers/corr-distance-worker.ts`), once, and returns the per-pair distance and r as typed arrays; the per-frame loop never sees it. Measured on 650 cells x 18,000 frames (random layout, uniform noise): 0.2 s with about 11,600 pairs within 6 D (D = 14 px), 1 s with about 73,000 (D = 40 px), in Node; one 47 MB f32 copy of the traces in the worker plus the same on the main thread while it is gathered. Real recordings may also share signal between
neighbours (neuropil, motion), so read the excess against a population null or a
before/after contrast, not as absolute leak. The plot data is not in the export.

## Sessions: library-flow modes

A run can hold several recording sessions of one animal (`src/lib/sessions.ts`,
`src/lib/session-run.ts`). The **library-flow mode** says how the stages above
compose with the sessions. It is a run setting, chosen on the session list.

| Mode         | Discover                                        | Extract                          | Cell ids              |
| ------------ | ----------------------------------------------- | -------------------------------- | --------------------- |
| **Separate** | per session, one after another (look-back on)   | per session                      | per session           |
| **Joint**    | once, through all sessions in order (look-back) | every session, the final library | same in every session |
| **Apply**    | none: a fixed library                           | per session                      | the library's         |

- **Joint** opens the sessions as one recording (`FrameSource.openSessions`):
  frames follow one another and `info.sessions` says where each session
  starts. Extract runs once over all of them with the final library, and the
  export is cut per session, so each session gets its own file with the same
  cell ids. The engine runs straight across a boundary, as it did when sessions
  were concatenated by hand.
- **Look-back in a Joint run.** While Discover runs, look-back (need-driven
  and the Background settle) re-reads frames of the current session only:
  from a session's first frame on, the slow loop never hands out an earlier
  frame (`SlowLoop.setLookbackFloor`), so a frame is never preprocessed across
  a boundary. The Final settle after the last frame samples the whole run (the
  same plan and cap as one recording of that length; the footprints are shared
  by every session) and preprocesses each frame as its own session's, as
  Extract's replay does: the recorded flicker, the session's recorded
  re-registration before the rigid shift, and the back half from that
  session's own state (stage C snapshots each session's first and last batch;
  the source mask follows the session warp). See `lib/lookback-reader.ts`.
- **Separate** opens one session at a time and runs Discover (with look-back
  and the Final settle) and Extract on it before the next.
- **Apply** is not built. It needs a starting library from a file (the
  `LibrarySource` `file` variant below); `LibraryMode` has the slot.
- A multi-session run is automatic. After Discover (and its Final settle) it
  runs Extract, then writes the results. In
  Separate mode it then opens the next session. A failed or cancelled stage
  stops the automatic run. A session where Discover finds no cells is skipped
  and marked so in the manifest.
- A single folder with one recording stays a one-session run with no automation.

### Boundaries

The frame source knows each frame's session (`sessionOfFrame`) and the
boundary frames (`sessionBoundaries`). The pipeline plan cuts the batch before
a boundary short, so every session starts a batch. Both pipeline engines call
`sessionHooks.onSessionBoundary(index, frame)` (`src/lib/session-boundary.ts`)
before that batch.

With `PipelineOptions.sessionFix` on (the default), the stages carry the run
into the new session (measured in
`tools/cala-eval/results/2026-11-13-session-boundary-fix.md`). Within a session
nothing changes, and a one-session run is byte-identical to before.

- **Re-registration (stage B).** The mean of the new session's first batch is
  registered onto the mean of the previous session's last 100 registered frames:
  a translation search of ±40 px and rotations of ±3° (a similarity transform,
  `SessionAligner`). The transform is applied to every frame of the session
  before the per-frame corrector, which then works as within a session.
  - A rotation is applied when it is at least 0.1° and removes at least 10 % of
    the unrotated fit's decorrelation.
  - Without one, a translation beyond 10 px is applied as a whole-pixel shift;
    a smaller one is left to the corrector (its ±15 px search catches it).
  - The reference is the previous session's registered frames, not the
    corrector's template, because the template covers only the registration
    region (at most 384 px), too small for a ±40 px search.
  - Pixels the warp brings in from outside the FOV are missing data, as for
    the per-frame shifts. The flat-field estimator gets the session's
    translation added to each shift, and no frames of a rotated session.
- **Flicker (stage A).** The flicker reference is re-seated on the new session,
  as at the start of a recording, so a brightness step is not read as flicker
  and released over a second.
- **Background floor and noise map (stage C).** A gain and offset fitted
  between the first batch and the floor's boxcar of the previous session's
  last frames (trimmed least squares, corrected for the boxcar's noise) map
  the floor into the new session's brightness. The noise map is scaled by the
  new session's noise (the median of its frame differences in units of the old
  map). Fast-loop warm starts and slow-loop statistics are not reset: the
  measurement showed no benefit.
- **Extract** replays it: A and C redo their steps on the replayed
  frames (the flicker comes from the record), and B applies the transform
  recorded in the run record (`RunRecord.noteSession`). A run recorded before
  this has no transforms and replays without re-registration.
- The batch's step result carries what was done (`session`), and the run's
  event log gets a `setting` event ("session boundary") with the transform,
  floor gain and noise factor.

The run's event log gets a `session` event at each boundary as Discover
reaches it; the History plots and the cell trace draw a line there. The
session metadata and the run manifest list the boundary frames.

### Boundary flags

Discover of a Joint run judges each boundary: **ok**, **warning** or
**failed**, with a plain-language reason (`src/lib/boundary-flags.ts`,
`BoundaryMonitor`, fed by the pipeline store). The flags are observers: they
never change processing, and a one-session run computes none. Each threshold
compares a statistic of the boundary with a null built from the same
recording; the few fixed choices are in `BOUNDARY_FLAG_RULES` (one place).

| group                       | check          | what it reads                                                                                                                                                                                                                                                 | warning                                                                    | failed                                                                        |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| alignment (at the boundary) | `match`        | the re-registration's `ncc` against the same correlation within the sessions before: a block of 100 registered frames and the next batch, without rotation (`SessionAligner.nullSample`, one sample per ~108 frames), on the log decorrelation `−ln(1 − ncc)` | outside the null                                                           | nearer the chance level than a within-session match (keeps < ½ of its margin) |
|                             | `search_edge`  | the best rotation at the edge of the ±3° grid, or the best shift within 1 px of the ±40 px search                                                                                                                                                             | pinned, match ok                                                           | pinned, match not ok                                                          |
| change (after the window)   | `floor_fit`    | `floorKept`: the share of pixels the floor's gain/offset fit follows                                                                                                                                                                                          |                                                                            | under ½ (the fit describes a minority: a change it cannot model)              |
|                             | `noise_drift`  | ln(noise σ at the window's end / at its start) after the rescale, against the same over windows within the sessions before                                                                                                                                    | outside the null, and larger than the rescale's own step (ln `noiseRatio`) |                                                                               |
|                             | `floor_drift`  | the floor's move over the window in noise σ, against the same                                                                                                                                                                                                 | outside the null, and larger than the floor's step at the boundary         |                                                                               |
| outcome (after the window)  | `new_cells`    | slow-loop adds in the window, against the adds per window within the sessions before                                                                                                                                                                          | outside the null                                                           | and the excess is more than ½ the library at the boundary                     |
|                             | `silent_cells` | cells active in the window before the boundary (peak SNR ≥ 5, QC's pass rule, noise from the trace's first differences) that are silent or gone in the window after, against the same share between consecutive windows within the sessions before            | outside the null                                                           | and the excess is more than ½ of the active cells                             |

- **Chance level.** `SessionAligner.beginSession` also scores the moving image
  mirrored (rows, columns, both) over the same translation search: unrelated
  content with the same texture. Its best correlation is what the search finds
  by chance (`chanceNcc`). Within a session the match sits near 1; a field of
  view that is not the previous one sits near chance.
- **Outside the null** means 3.5 robust standard deviations (median and MAD),
  the Iglewicz & Hoaglin (1993) outlier cut for the modified z score. Counts
  use the same cut on the Anscombe scale (2√(x + 3/8)), divided by the null's
  overdispersion (variance over mean, at least 1); the silent share uses a
  quasi-binomial z with the null's dispersion.
- **Drift after a rescale.** The trackers settle a little after any boundary
  (the floor relaxes upward with τ = 120 s), while within a session they sit
  still, so the within-session null alone flags normal boundaries. A drift
  warns only when it is also larger than the step the rescale applied: the
  correction captured under half of the change (the majority rule).
- **Failed** is the majority rule: under half of a match's margin over
  chance, a fit that follows under half the pixels (the breakdown point of
  its median-based trimming), an excess of more than half the library or of
  the active cells.
- **The window** is `BOUNDARY_FLAG_RULES.windowS` = 30 s of stream after the
  boundary, in frames at the recording's fps (Miniscope recordings run
  10–60 fps). The within-session windows are the same length, aligned to each
  session's start; the first two of every session are left out (a run's
  discovery warm-up, and the window after a boundary). The null comes only
  from the sessions before the boundary. With fewer than 3 null samples a
  check says it is not judged.
- **When.** Alignment is judged at the boundary; change and outcome once the
  window has played in the fast and the slow loop (until then the flag is
  "ok so far", `pending`). A run that ends first leaves them not judged.
- **Where it shows.** A History event ("boundary check": a `warning` for a
  warning or failed boundary, a `setting` for ok) each time a verdict changes;
  the boundary line on the cell trace (orange for a warning, vermillion with a
  "!" for failed); a badge in the multi-session run's list; the export
  (`meta_json.session.boundary`, export format 6), `cala-session.json`, the run
  manifest and the project index (`runs[].sessions[].boundary`), so the
  session table and View results show it.
- **What to do.** A failed boundary suggests running those sessions Separate.
  The session table's **Re-plan as Separate** puts the chain's sessions into
  the run plan as Separate runs; nothing switches by itself.
- Calibration (stitched sims and Samara's real Joint data):
  `tools/cala-eval/results/2026-11-13-boundary-flags.md`;
  `tools/cala-eval/boundary_flags_eval.ts` runs the same monitor on a
  `qc_eval --sessions … --session-fix all --boundary-log --churn-log` run
  (which writes the null samples to `boundary_null.tsv`).

### Results

Each session's results are written when they are final: after its Extract
(Separate), or for all sessions after the final Extract (Joint). They go to a
tree parallel to the data, never into a data folder:

```
<results location>/cala-results/              (cala-results_<date>_<time> if it exists)
  cala-run.json                               mode, settings, sessions, boundaries
  2026_11_10/14_02_33/My_V4_Miniscope/        the session's path below the picked folder
    cala-export.npz                           export format 3, meta_json.session added
    cala-session.json                         app version, mode, stages run, session index
                                              and path, boundary frames, library version,
                                              shared cell ids (Joint)
```

The location defaults to the picked data folder; `readwrite` is asked for
when the run starts. Without the File System Access API the same tree
downloads as `cala-results.zip` when the run ends (each file is built in
memory first). A manual Extract after the run writes nothing automatically;
use Export.

An animal project ([projects.md](projects.md)) runs the same flows from its
session table as a run plan of Joint chains and Separate sets, writes each run
to `cala-results/runs/<run id>/` with the same layout, and indexes them in
`cala-results/cala-project.json`.

## Deferred

- **Repeated Discover** ("Discover again") is not offered. It would replay the
  same frames, so its add test would count the same evidence twice; a separate
  measurement will decide. (The slow worker's `replay` message, which Refine
  used and which could carry `all`, was removed with Refine.)
- **Merge-only and split-only runs** have no UI. The engine's `EditScope` stays
  general (`refine-prune`, `refine-merge`; `qc_eval --later-passes`), and
  `SlowLoop.setEditScope` accepts every name (the Final settle uses `refine`).
- **Starting library from a file** (a past session) is deferred until
  cross-session alignment exists. For 1p miniscope data this is mainly lateral
  registration; z-drift is not an issue. The hook is `LibrarySource` in
  `src/lib/run-stages.ts`, where a `file` variant would go. A run would then
  start the fast loop with that library (`CellsSettings.library`) and seed
  the slow loop with it. There is no UI.
