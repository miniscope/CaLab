# Run stages: Discover, Refine, Extract

A cala run is made of named stages. They replace the older "pass 1 / pass 2".
The names are the same in the UI, the export metadata (`meta_json.stages`), the
run's event log and these docs.

| Stage        | What it does                                                                                                                                                                | Streaming | Recording                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| **Discover** | Finds cells and builds their footprints from an empty library, with live traces. Every edit is allowed: adds, absorbs, splits, merges, keep tests and deletions.            | yes       | yes (first)                                                   |
| **Refine**   | Replays the recording from frame 0 into the same slow loop. Footprints keep converging; the cell set is frozen (no adds, absorbs, splits, merges, keep tests or deletions). | no        | after Discover, repeatable                                    |
| **Extract**  | Solves the final traces of every frame with the footprints frozen.                                                                                                          | no        | after Discover; once at the end, again if the library changed |

## Order

- Refine and Extract run only after Discover has finished and the slow loop has
  published its final library (`stageAvailability` in `src/lib/run-stages.ts`).
- One replay runs at a time: no Extract while Refine runs and no Refine while
  Extract runs.
- Refine can run any number of times. Each run starts from the library the
  previous one published.
- A Refine run after an Extract discards the Extract result, because its
  traces no longer match the footprints. The panel says so and asks for
  Extract again.
- **Extract after Discover** (off by default for recordings) starts Extract
  when Discover finishes, but never after a Refine run. It is off so that a
  Discover, Refine, Extract flow does not waste an Extract run that Refine
  would discard. After Discover the panel shows the Refine and Extract buttons
  with the hint "Refine to let footprints settle, then Extract final traces."
  Turn the option on to extract straight away. The option is not saved
  between sessions.
- A new Discover run (Restart) starts the stage log over.
- **Streaming runs Discover only.** A live source has no file to replay, and
  cala does no live re-processing. Save the stream and load it later as a
  recording to Refine and Extract it.

## What carries over between stages

Refine is the same engine path as `qc_eval --passes N --later-passes refine`.
The JS `SlowLoop.setEditScope('refine')` is `SlowLoop::set_edit_scope(EditScope::Refine)`,
and the recording is fed again from frame 0. A Rust test
(`js_refine_replay_is_refine_only_deterministic_and_matches_qc_eval`) checks
that the JS surface gives the same libraries, bit for bit.

- **Slow loop, all of it.** Footprints, footprint statistics, evidence ledger,
  probation, the frame counter (running statistics with half-lives see a
  Refine run as more time) and the reservoir. The slow worker keeps its
  `SlowLoop` across the replay (`FastToSlow` `replay` message, `keepSlow` on
  the pipeline stop). Visit jobs carry the edit scope, so visit workers follow
  it.
- **Library.** The fast loop solves with Discover's (or the previous
  Refine's) final library from frame 0, and swaps in new ones as Refine
  publishes them.
- **Motion.** Replayed from Discover's record (`RunRecord`). There is no
  re-registration.
- **Flicker.** Replayed from the record.
- **Flat field.** Discover's newest map is applied from frame 0. It gets no
  more updates.
- **Noise map.** The slow loop keeps Discover's newest map; a Refine run sends
  none. The preprocessor's own state (background, noise) is rebuilt by the
  replay from the calibrated state, as in Extract.
- **Not carried over.** The fast loop's trace-solver warm start: each replay
  builds a new engine. QC is not run during Refine or Extract; the QC columns
  of the export come from Discover's last snapshot.

One difference from qc_eval is known: qc_eval's fast loop carries its trace
engine and preprocessor across the wrap. The app rebuilds them. (The engine's
ring-background levels go to the slow loop with each frame's traces, in
Discover and in Refine alike, as qc_eval passes them.)

With `--later-passes refine`, qc_eval now publishes the final library at each
wrap and solves the next pass with it, as the app does at the end of a stage.

Refine does not drop frames for the slow loop. The main thread asks for the
next batch only while the slow loop has fewer than `REFINE_SLOW_LEAD` (four)
batches sent and not yet taken: two in the pipeline workers, one being
observed, one waiting. The forward pool of a Refine run never drops a batch
(a lossless `ForwardPool`), so the slow loop observes every frame in order. A
file can wait; Discover on a live stream cannot, so Discover drops frames
when the slow loop is busy.

With visit workers, a Refine batch gives way to the slow worker's messages
between frames while a visit is out (`SlowRunner.handleAsync`): visit results
are applied, and the next visits handed out, without waiting for the rest of
the batch. Without that, once frames came as fast as the slow worker could
observe them, its visit workers sat idle and a run made a few times fewer
visits per frame. How many visits a run makes per frame, and so how much refining
a run does, depends on the machine's speed, in Refine as in Discover (PI
decision, 13 Nov 2026).

With visit workers, a Refine visit that would not refine (a tile refines on
every other visit, and Refine has no adds, merges or keep tests) is made by
the slow worker when it is due, not shipped to a visit worker with the tile's
whole reservoir. That is about half a Refine run's visits. The footprints are
the same with and without this (a Rust test checks it, bit for bit).

## Per-stage readout

The stage log (`createStageLog`) records each run: stage, index, start and end
time, outcome, frames, cells and library version. The stages add their own
counts:

- **Discover:** adds, merges, deletes, splits and refines (the slow loop's
  counters).
- **Refine:** the following, all against the library at the start of the run.
  - **Footprints refined:** cells whose footprint changed at all.
  - **Median footprint change:** the median of `|a' - a| / |a|` over the
    refined footprints. Taken over all cells it would read 0 whenever fewer
    than half of them changed, which happened on the browser check.
  - **Refines per minute** of recording, and the ratio to the previous run
    (Discover or the previous Refine). The panel shows it as, for example,
    `0.42× Refine 1`.
- **Extract:** frames and cells.

The export's `meta_json.stages` holds the same records (format version 3).

## Refine plots

Under the Refine readout the Run panel draws two plots (`components/RefinePlots.tsx`,
with the metrics in `src/lib/refine-metrics.ts`):

- **This run over the replay.** The current or last Refine run, plotted
  against the replay's stream time with the History's `HistoryPlot`:
  - refines per minute over the last minute of the replay (none before 10 s);
  - at each library publish, the median and the 90th percentile of
    `|a' - a| / |a|` over the footprints that publish changed (stems);
  - the share of cells this run has refined at least once.

  The ranges are declared like every History series: 0–50 /min and 0–0.5,
  each stepping up a 1/2/5 ladder (never down), and 0–1 fixed for the
  share.

- **Across runs.** Refines per minute for Discover (D) and for each Refine
  run, and the median footprint change of each Refine run. These are two
  small plots, each with its own y axis anchored at 0. The top is the
  series' initial range, or the 1/2/5 step that holds every run. A run
  that was cancelled or stopped shows as a hollow dot. The settled hint
  (below) sits under these plots.

The export carries the same numbers. Each Refine run in `meta_json.stages`
adds `change_p90` and `refined_share`, and a `series` object of columns: `t`
(stream s), `refines`, `refines_per_min`, `changed`, `change_median`,
`change_p90` (set at publishes, null elsewhere) and `refined_share`.

## The settled signal

Main uses the split-half refine gate (#367): a refine is published only when
the change exceeds the estimate's split-half noise. The refines a run publishes
therefore measure how much is still moving.

The panel shows a gentle "Looks settled" hint when either of these holds:

- the run published no refines;
- the refine rate has stopped falling: it did not rise (ratio at most 1),
  and this run's ratio to the previous run is no smaller than the previous
  run's ratio to the run before it.

The rule compares the measured ratios only and has no threshold constant. A
fixed cut-off, such as "below 0.2× the previous run", was left out on purpose.
Pick one from data, such as `tools/cala-eval/results/2026-11-12-skirt-stability.md`
§5, where the typical cell is flat by pass 4.

## Sessions: library-flow modes

A run can hold several recording sessions of one animal (`src/lib/sessions.ts`,
`src/lib/session-run.ts`). The **library-flow mode** says how the stages above
compose with the sessions. It is a run setting, chosen on the session list.

| Mode         | Discover                            | Refine               | Extract                          | Cell ids              |
| ------------ | ----------------------------------- | -------------------- | -------------------------------- | --------------------- |
| **Separate** | per session, one after another      | per session          | per session                      | per session           |
| **Joint**    | once, through all sessions in order | replays all sessions | every session, the final library | same in every session |
| **Apply**    | none: a fixed library               | none                 | per session                      | the library's         |

- **Joint** opens the sessions as one recording (`FrameSource.openSessions`):
  frames follow one another and `info.sessions` says where each session
  starts. Extract runs once over all of them with the final library, and the
  export is cut per session, so each session gets its own file with the same
  cell ids. The engine runs straight across a boundary, as it did when sessions
  were concatenated by hand.
- **Separate** opens one session at a time and runs Discover, Refine and
  Extract on it before the next.
- **Apply** is not built. It needs a starting library from a file (the
  `LibrarySource` `file` variant below); `LibraryMode` has the slot.
- A multi-session run is automatic. After Discover it runs the chosen number
  of Refine runs (default 1, 0 to 5), then Extract, then writes the results. In
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
- **Refine and Extract** replay it: A and C redo their steps on the replayed
  frames (the flicker comes from the record), and B applies the transform
  recorded in the run record (`RunRecord.noteSession`). A run recorded before
  this has no transforms and replays without re-registration.
- The batch's step result carries what was done (`session`), and the run's
  event log gets a `setting` event ("session boundary") with the transform,
  floor gain and noise factor.

The run's event log gets a `session` event at each boundary as Discover
reaches it; the History plots and the cell trace draw a line there. The
session metadata and the run manifest list the boundary frames.

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
  measurement will decide. The code can add it: the slow worker's `replay`
  message takes any `EditScopeName`, and `all` is Discover again
  (`qc_eval --later-passes all`).
- **Merge-only and split-only runs** have no UI. The engine's `EditScope` stays
  general (`refine-prune`, `refine-merge`; `qc_eval --later-passes`), and
  `SlowLoop.setEditScope` accepts every name.
- **Starting library from a file** (a past session) is deferred until
  cross-session alignment exists. For 1p miniscope data this is mainly lateral
  registration; z-drift is not an issue. The hook is `LibrarySource` in
  `src/lib/run-stages.ts`, where a `file` variant would go. A run would then
  start the fast loop with that library (`CellsSettings.library`) and seed
  the slow loop with it. There is no UI.
