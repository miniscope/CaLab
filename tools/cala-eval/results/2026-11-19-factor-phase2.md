# Factor pipeline, phase 2: Extract on the factors

Spec: `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md` (phases table row 2; Amendment 1, A1 and A6;
Amendment 2, A8).
Plan: `docs/superpowers/plans/2026-11-18-cala-factor-phase2.md`.
Commits: `qc_eval` built at da6759da (all arms except the rerun of `c_chosen`) and at b6990928 (the rerun of
`c_chosen`), both on `feat/cala-factor-extract` after the merge of main (cdccdbab). Machine: Apple M1 Max, 10 cores,
32 GB. Runs of 18 and 19 Nov 2026. Data: the run folder `factor_phase2_20261118`.

Phase 2 changed how Extract gets a frame's trace. Before, the final trace solve rebuilt each frame from the stored
factors and projected it onto the cells. Now the solve takes each frame's projections straight from the factors of a
600-frame window (`WindowProjector`, `FactorExtractor`) and never rebuilds the frame. The arms per recording:

- `raw` (A): the file pipeline.
- `chosen` (B): Refine and Extract on frames rebuilt from recalibrated factors on the offset grids. The frame engine.
- `c_chosen` (C): the same, with Extract on the factor engine.
- `null_lo`, `null_hi`: `raw` at half and twice the slow-loop budget.

Gate A1 compares an arm with `raw` over the QC-pass cells. A loss is 1 minus the median of a measure over those cells.
A trace difference is the largest absolute difference of two traces of one cell, over the standard deviation of the
first trace (in units of "sd").

## Summary

- **A against C: `c_chosen` meets gate A1 on all six recordings.** No QC-pass cell is lost. Its A1 values equal
  `chosen`'s to four decimals, and its footprints are the same bytes as `chosen`'s.
- **B against C: the unit tests agree to about 1e-4 absolute; on real recordings the two engines differ more.** The
  unit test's largest gap is 8.2e-5 absolute (5.0e-5 relative), independent of the solver's stopping tolerance: it is
  f32 rounding of the two input routes amplified by the solve (about 25 f32 steps at the trace scale, not one). The
  spec's "to float32 rounding" is met in that sense only. On the data the two engines end with the same footprints on
  all nine runs, but the trace difference has a median of 0.0147 and 0.0162 sd on the two WL24 recordings (largest
  0.4454, one cell) and 0.0000 to 0.0021 on the other four.
- **Extract is 22 to 137 times faster on the factors** (wall, `chosen` against `c_chosen`: 18 to 78 s against 0.5 to
  1.1 s at the scale run here).
- Open points:
  - **Cluster replay (main's joint flags on):** on `joint_wl24_01` both `chosen` and `c_chosen` fail rule 2 (footprint
    loss 0.0305 against 0.02). The largest null loss of that measure is 0.0143, and the same recording without the
    replay had 0.0086. A result for the owner.
  - **Missing pixels:** the engines differ where a pixel was never valid in a window. `min_valid` explains the one
    large outlier, not the general level; the likely cause of the level is such pixels in the cells' moat blocks.
    Likely, not shown.
  - **Browser:** the back-fill from the factors ran in Chrome on `wl24_01` and `v4`, once each, under load: it arrived,
    at 0.111 and 2.57 ms per frame, with no compress worker error. No before/after on the same machine state exists.
  - **Not measured:** the back-fill's longest batch, an idle-machine time, its traces against the frame engine's on data,
    the app's extractor setting (consolidated ring gradient off) on data, and a short last window in the gate runs.

## Gate

### (a) B against C: the factor engine against rebuilt frames

**Unit tests.** `traces_from_the_factors_equal_traces_from_the_rebuilt_frames` (crates/cala, `compress/project.rs`;
added in 7e88143e, tightened in d1e5e0e3) runs three tilings and three background models. Its largest gap is 8.2e-5
absolute and 5.0e-5 relative (plain tiles, ring background); its tolerance is 2e-4 times (1 plus the trace value). The
gap does not move when the solver's tolerance goes from 1e-4 to 1e-7 (a reviewer's measurement; at 1e-5 or below the
f32 solve does not converge). So it is not the solver stopping early: it is f32 rounding of the two input routes
(rebuilt frame then projection, against projection from the factors), amplified by the solve to about 25 f32 steps at
the trace scale. This is "agree to about 1e-4 absolute", not "to float32 rounding" and not 1e-7. The test passed in the
branch checks recorded at the end of the fix wave; it was not re-run for this report.

**On data.** Every recording: the two runs end with the same footprints (yes on all nine run folders), so their
libraries are the same and the traces can be compared cell by cell.

Trace difference over the trace's sd, `c_chosen` against `chosen` (cells; median / largest):

| recording | all cells            | 16 px or more from the border | under 16 px from the border | `min_valid` below 1 | `min_valid` equal to 1 |
| --------- | -------------------- | ----------------------------- | --------------------------- | ------------------- | ---------------------- |
| wl200     | 72; 0.0002 / 0.0995  | 66; 0.0002 / 0.0995           | 6; 0.0003 / 0.0035          | 0                   | 72; 0.0002 / 0.0995    |
| wl24_01   | 102; 0.0162 / 0.0634 | 75; 0.0159 / 0.0634           | 27; 0.0172 / 0.0315         | 2; 0.0172 / 0.0248  | 100; 0.0162 / 0.0634   |
| wl24_04   | 64; 0.0147 / 0.4454  | 53; 0.0147 / 0.4454           | 11; 0.0132 / 0.0340         | 3; 0.0955 / 0.4454  | 61; 0.0146 / 0.0474    |
| plain     | 188; 0.0004 / 0.0094 | 188; 0.0004 / 0.0094          | 0                           | 0                   | 188; 0.0004 / 0.0094   |
| v4        | 219; 0.0021 / 0.0132 | 219; 0.0021 / 0.0132          | 0                           | 0                   | 219; 0.0021 / 0.0132   |
| motion    | 262; 0.0000 / 0.0028 | 258; 0.0000 / 0.0028          | 4; 0.0001 / 0.0002          | 0                   | 262; 0.0000 / 0.0028   |

`min_valid` is the smallest share of a window's frames in which every pixel of a cell's support was present, over all
windows (from the file `extract_min_valid.tsv` of the factor-engine run). A pixel that was never valid in a window is
stored as 0. The factor engine reads that 0; the frame engine on a replay treats the pixel as missing. Only the support
is counted: a cell with a missing pixel in its moat or ring block still has `min_valid` 1 and can differ, so the
column "equal to 1" is not a clean set. The border column is the earlier proxy (centroid distance to the frame
rectangle).

What the table says:

- **Cells away from the border do not agree to rounding on real recordings.** On `wl24_01` and `wl24_04` the median
  cell differs by 0.0159 and 0.0147 sd. On the three simulated recordings the median is 0.0000 to 0.0004 sd; on `v4`
  (real) 0.0021. The three real recordings differ most.
- **Border cells are no worse than the rest.** The border band is not a useful proxy: on `wl24_01` its median is
  0.0172 against 0.0159 for the cells away from the border, and on `wl200` none of the six border cells has a missing
  support pixel.
- **One large outlier:** `wl24_04` cell 58 (0.4454 sd; 0.28 absolute on a peak of 3.4; `min_valid` 0.000; 26.8 px from
  the border). `min_valid` picks it and the two other cells of `wl24_04` below 1 (median 0.0955 sd). The 61 cells at 1
  there have a median of 0.0146 and a largest of 0.0474.
- **`wl200` has one cell at 0.0995 sd** (cell 15, `min_valid` 1, 26.3 px from the border; 0.045 absolute on a trace
  with sd 0.45). It has no missing support pixel. Its cause is not known.
- **`min_valid` does not explain the general level.** On `wl24_01` the two cells below 1 (median 0.0172) are no
  different from the 100 at 1 (median 0.0162).

Inferred, not shown: the level of about 0.015 sd on the WL24 recordings comes from pixels that were never valid in a
window and lie in the cells' moat blocks, which `min_valid` does not count. The reason to suspect it: the real
recordings have fixed non-finite pixels (the whole-branch review counted 30 to 105 per real recording; not recounted
here), and a unit test with one missing pixel in a neighbour's moat block measured 1.7e-3 relative while the cell with
the pixel under its support differed by 8.9e-2. What would show it: count the missing pixels of the moat and ring
blocks too and split the table by that count; or run the frame engine on the replay with the stored 0 instead of
"missing" for those pixels (an arm B') and check that B' against C agrees to about 1e-4 as the unit test does.

### (b) A against C: gate A1

`c_chosen` against `raw`, as the A1 table at the end of each recording's `report.md` gives it. Limits: rule 1 median at
least -0.01 and 5th percentile at least -0.05 (applies when the reference has at least 20 QC-pass cells with a truth
correlation and their median is at least 0.8); rule 2 footprint loss at most 0.02; rule 3 trace loss at most 0.08
(applies when rule 1 does not); rule 4 tile-line jump at most 0.10 above raw's.

| recording | QC-pass cells (lost) | 1 truth: median, 5th pct                  | 2 footprint loss | 3 trace loss           | 4 jump, arm / raw   | gate |
| --------- | -------------------- | ----------------------------------------- | ---------------- | ---------------------- | ------------------- | ---- |
| wl200     | 63 (0)               | +0.0132, -0.0272 (22 cells): pass         | 0.0052: pass     | 0.1039: does not apply | 0.968 / 0.976: pass | pass |
| wl24_01   | 58 (0)               | no truth: does not apply                  | 0.0086: pass     | 0.0441: pass           | 1.060 / 0.995: pass | pass |
| wl24_04   | 40 (0)               | no truth: does not apply                  | 0.0072: pass     | 0.0487: pass           | 1.099 / 1.049: pass | pass |
| plain     | 142 (0)              | +0.0016, -0.0050 (135 cells): pass        | 0.0000: pass     | 0.0015: does not apply | 0.965 / 0.962: pass | pass |
| v4        | 202 (0)              | no truth: does not apply                  | 0.0000: pass     | 0.0010: pass           | 0.931 / 0.929: pass | pass |
| motion    | 178 (0)              | not usable (median 0.403): does not apply | 0.0006: pass     | 0.0009: pass           | 0.890 / 0.897: pass | pass |

`c_chosen` meets A1 on all six recordings. These are the values of `chosen` in phase 1 to four decimals (the trace loss
of `c_chosen` differs from `chosen`'s by 0.00001 on `wl24_01` and `wl24_04`). It is expected: both arms end with the
same footprints, and the factor engine changes only the traces of the final Extract. The closest margins are the same
as in phase 1: the tile-line jump on the two wireless recordings (up by 0.065 and 0.050 of an allowed 0.10) and the
trace loss there (0.0441 and 0.0487 of 0.08). On `wl200` the pass rests on rule 1 over 22 cells, its 5th percentile
(-0.0272) being one or two cells, as before.

**Decision: open, for the user.**

## How it was measured

`tools/cala-eval/factor_arms.py` ran `qc_eval` once per arm and recording from the script `run_all.sh` in the run
folder (log `run_all.log`).

- **Scale, as in phases 0 and 1.** 200 px recordings (`wl200`, `wl24_01`, `wl24_04`): first 12000 frames, 5 refine
  replays, 3 runs at once; arms `raw`, `null_lo`, `null_hi`, `chosen`, `c_chosen`. 600 px recordings (`plain`, `v4`,
  `motion`): first 6000 frames, 2 refine replays, 2 runs at once; arms `raw`, `null_lo`, `chosen`, `c_chosen`. Slow-loop
  budget 3,000,000 work units per frame (a tenth of the default); the nulls use half and twice that in the replays.
  `wl200`, `plain` and `motion` are simulated, with truth; `wl24_01`, `wl24_04` and `v4` are real recordings.
- **Return codes.** Every arm of all nine run folders ended with return code 0 (first runs; the rerun of `c_chosen`
  too). In every folder `c_chosen` ends with the same footprints as `chosen`.
- **Arms `chosen` and `c_chosen`.** Two offset grids (`--tiling offset`), factors written during the first refine
  replay (`--factors-pass 2`), recalibrated; later replays solve on frames rebuilt from them. They differ in one flag:
  `c_chosen` has `--extract-engine factors`, so only the final Extract solves from the factor files. `c_chosen` is a
  full run of its own, not a re-extract of `chosen`; that both ended with one library is what "same footprints" shows.
- **Rerun of `c_chosen`.** After the fix wave of the phase (harness commit b6990928) every `c_chosen` was run again
  with the same command, to get `extract_min_valid.tsv`; the first run is kept as `c_chosen_before_min_valid`. The
  traces of the two runs are the same bytes in all nine run folders (`cmp` on the six gate recordings, and the last lines of `rerun_c.log` for all nine). All other arms were run
  once, with the da6759da build. Tables here use the rerun, except where said.
- **Frame route unchanged.** `raw/extract_trace.f32` and `chosen/extract_trace.f32` of all six recordings are the same
  bytes as in phase 1's run folder `factor_phase1_20261118` (checked with `cmp`; same commands, same scale). So the
  solver split, the harness changes and the merge of main (commit cdccdbab, origin/main at 63676444, merged before the
  runs) changed no output of the frame route.
- **Cluster replay runs.** `joint_wl200`, `joint_wl24_01`, `joint_plain`: the same arms with
  `--joint-update all --joint-sign all` on every arm and pass (`factor_arms.py --extra`), main's reference setting.
- **Timing caveat.** The arms of a recording ran 3 (or 2) at a time on one machine, and the rerun of `c_chosen` ran
  alone, so times are indicative. The two runs of `c_chosen` differ by up to 1.7 times on `wl200` (0.46 and 0.76 s of
  Extract wall).
- **Numbers** in this report were computed by short scripts over the run folder's `report.md`, `run.json`,
  `stage_times.tsv`, `footprints.bin`, `extract_trace.f32` and `extract_min_valid.tsv`, and the report's engine table by
  the tool's own functions; not copied by hand.

## Speed, native

Extract pass, seconds preparing / solving / wall (the file read and the output write are in the wall only), and frames
per second (frames over wall). "Preparing" means, for the frame engines (`raw`, `chosen`): preprocessing each frame
(motion correction, background), and for `chosen` also rebuilding it from the factors; for the factor engine
(`c_chosen`): building the projector of each window from its factor file. `c_chosen` first run in brackets.

| recording | frames | `raw`                | `chosen`             | `c_chosen`                     | frames per second: `raw` / `chosen` / `c_chosen` | `chosen` wall over `c_chosen` wall |
| --------- | ------ | -------------------- | -------------------- | ------------------------------ | ------------------------------------------------ | ---------------------------------- |
| wl200     | 12000  | 13.82 / 1.87 / 15.79 | 16.39 / 1.79 / 18.29 | 0.08 / 0.66 / 0.76 (0.46 wall) | 760 / 656 / 15789                                | 24                                 |
| wl24_01   | 12000  | 13.91 / 5.14 / 19.17 | 18.09 / 5.07 / 23.27 | 0.09 / 0.93 / 1.05 (1.04 wall) | 626 / 516 / 11429                                | 22                                 |
| wl24_04   | 12000  | 19.59 / 5.46 / 25.17 | 17.23 / 3.58 / 20.90 | 0.07 / 0.41 / 0.50 (0.48 wall) | 477 / 574 / 24000                                | 42                                 |
| plain     | 6000   | 55.18 / 3.28 / 58.88 | 67.51 / 3.26 / 71.19 | 0.10 / 0.36 / 0.52 (0.53 wall) | 102 / 84 / 11538                                 | 137                                |
| v4        | 6000   | 55.03 / 5.64 / 61.09 | 71.59 / 5.71 / 77.76 | 0.13 / 0.85 / 1.07 (1.24 wall) | 98 / 77 / 5607                                   | 73                                 |
| motion    | 6000   | 68.65 / 5.41 / 74.55 | 69.64 / 4.45 / 74.54 | 0.16 / 0.80 / 1.04 (0.96 wall) | 80 / 80 / 5769                                   | 72                                 |

The factor engine is 22 to 137 times faster in wall than the frame engine on rebuilt frames (by the rerun's wall; 22 to
134 by the first run's). No frame is preprocessed or rebuilt, so the work that is left is the trace solve. On the factor engine, solving is 69 to 89 percent of the wall
(69 percent on `plain`, 87 on `wl200`, 89 on `wl24_01`); building the projectors takes 0.07 to 0.16 s per recording,
and the rest is reading the factor files. So what limits the factor engine is the solve, not the rows built per
window. For `chosen`, preparing is 78 to 95 percent of the wall. For scale: the stream's frame interval is 50 ms, and
the factor engine's Extract takes 0.04 to 0.18 ms per frame here (wall over frames).

Compression makes the same factors in both arms: mean rank and bytes per 1000 frames of `chosen` and `c_chosen` are
equal (for example `wl24_01`: rank 11.4, 9.6 MB per 1000 frames). The compression time per frame differs by up to 22
percent between the two (2.08 and 2.54 ms on `wl24_04`), which is run-to-run noise on a loaded machine.

## Speed, browser

All times in this subsection were measured under load: the native harness runs of another phase were going. The run
log prints "heavy processes: 6" at the start of the `wl24_01` run and "heavy processes: 4" at the start of the `v4` run.
They are not comparable with phase 1's idle-machine browser numbers, and no before/after measurement of the old back-fill
(frames rebuilt, frame engine) on the same machine state exists, so no speed-up is claimed.

Setup: `apps/cala/scripts/batch-session.mjs` through `run_browser.sh`, Chrome, port 4191, whole recordings, Discover then
Extract, no Refine, `?compress`, one run each, one after the other. The app was built by `npm run build:e2e` at the start
of the series (commit 72805628; the build's code on the back-fill path is phase 2's; the tree also held later phases'
library code, which the app does not call). The back-fill is read after Discover settles, from the driver's
`status.json`. Motion correction ran on WebGPU in both runs.

BROWSER RESULTS: the back-fill arrived in both runs.

|                                                                          | `wl24_01`                                            | `v4`                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ |
| frames, cells                                                            | 40234, 87                                            | 23711, 828                                             |
| QC line                                                                  | 87 cells: 76 pass, 11 low SNR, 0 possible duplicates | 828 cells: 783 pass, 0 low SNR, 45 possible duplicates |
| compress at the end of Discover: tiling, source                          | plain, discover                                      | plain, discover                                        |
| windows, final, settled                                                  | 68, yes, yes                                         | 40, yes, yes                                           |
| mean rank (frames-weighted over the session)                             | 10.65                                                | 8.40                                                   |
| compress ms per frame (session mean)                                     | 1.53                                                 | 13.07                                                  |
| MB of factors                                                            | 185.2                                                | 738.7                                                  |
| back-fill: arrived, library version                                      | yes, 357                                             | yes, 190                                               |
| back-fill: frames                                                        | 40234                                                | 23711                                                  |
| back-fill: ms per frame                                                  | 0.111                                                | 2.570                                                  |
| back-fill: frames per second (1000 over ms per frame)                    | 9012                                                 | 389                                                    |
| back-fill: mean time of one 64-frame batch (a mean, not a maximum)       | 7.1 ms                                               | 164.5 ms                                               |
| compress at the end of Extract: tiling, source                           | offset, replay                                       | offset, replay                                         |
| windows, final, settled                                                  | 68, yes, yes                                         | 40, yes, yes                                           |
| mean rank                                                                | 10.96                                                | 7.08                                                   |
| compress ms per frame (session mean)                                     | 2.89                                                 | 24.32                                                  |
| MB of factors                                                            | 370.0                                                | 1301.9                                                 |
| Extract's raw replay, frames per second (`stage_times.py` on the export) | 1323 (30.4 s)                                        | 116 (205.1 s)                                          |

- **Back-fill.** The driver read it after Discover: the factor engine on Discover's plain-tile factors, solving every
  frame of the recording. The library version is the one the compress worker held. The driver recorded no compress
  worker error, and the logs hold none; each log has one console error, a failed resource load (404) that was not
  identified.
- **Mean batch.** The back-fill solves 64 frames per yield. The table's batch time is 64 times the mean ms per frame.
  The longest single `solve` call is not logged: it was not measured, and the mean says nothing about it.
- **Cells.** `v4` has 828 cells, 9.5 times as many as `wl24_01` (87); the back-fill's ms per frame is 23 times higher.
- **Compress status.** Extract's replay recompresses on the offset grids (two grids, so 1.8 to 2.0 times the bytes), as in
  phase 1; its session mean ms per frame is higher than Discover's on both recordings. These compress times are also
  under load.
- **What this does not show.** The back-fill's traces were not compared with the frame engine's on these recordings:
  the unit test does that on a fixture (tolerance 1e-3, observed 5.7e-6, from the task record).

## Missing pixels

A cell's support is the set of pixels of its footprint. `min_valid` (defined above) below 1 means some pixel of the
support was missing in part of a window. Per recording:

| recording | cells | `min_valid` below 1 | share       | their trace difference, median / largest | the cells at 1, median / largest |
| --------- | ----- | ------------------- | ----------- | ---------------------------------------- | -------------------------------- |
| wl200     | 72    | 0                   | 0           | n/a                                      | 0.0002 / 0.0995                  |
| wl24_01   | 102   | 2                   | 2.0 percent | 0.0172 / 0.0248                          | 0.0162 / 0.0634                  |
| wl24_04   | 64    | 3                   | 4.7 percent | 0.0955 / 0.4454                          | 0.0146 / 0.0474                  |
| plain     | 188   | 0                   | 0           | n/a                                      | 0.0004 / 0.0094                  |
| v4        | 219   | 0                   | 0           | n/a                                      | 0.0021 / 0.0132                  |
| motion    | 262   | 0                   | 0           | n/a                                      | 0.0000 / 0.0028                  |

Only the two WL24 recordings have cells with a missing support pixel, and a small share of them (2.0 and 4.7 percent).
Those cells differ more between the engines than the rest (the large outlier is among them), but their number is small
and they do not set the general level. How a missing pixel is treated, and what that implies:

- **Where the engines differ.** The frame engine on a replay keeps a pixel that is not finite in the raw replay as
  missing and treats it as such in each frame. The factors store a pixel that was never valid in a window as 0 (and a
  partly valid pixel as the mean of its valid samples), and the factor engine reads that value. So B and C differ
  under a cell exactly where a pixel is missing in a window.
- **What `min_valid` counts.** The support only. The moat blocks (the pixels around a cell that the solve also reads)
  and the ring are not counted.
- **What a unit test measured.** One missing pixel under a cell's support: relative gap 8.9e-2 against `chosen`
  (the test asserts that it lies between the tolerance and 0.2); a neighbour with `min_valid` 1 whose moat block held the pixel: 1.7e-3.
  So a pixel in a moat block moves a trace by a few thousandths of its scale, and with 30 to 105 such pixels spread
  over a recording, most cells would have one in a block (inferred). That is the likely cause of the level, as said
  above; it is inferred, not shown.
- **Phase 3's rule for footprint statistics** (the spec's `MIN_VALID_SHARE`) is not applied here; this phase measured
  what the per-window treatment costs in traces.

## Cluster replay on the factors (main's joint flags, spec A8)

Main's cluster history replay builds its history from the frames the slow loop is fed, so a replay on frames rebuilt
from factors carries it unchanged. Measured with `--joint-update all --joint-sign all` on every arm of three
recordings. `chosen` and `c_chosen` have the same footprints and the same A1 values, so one row each:

| recording     | QC-pass cells (lost) | 1 truth: median, 5th pct (cells)   | 2 footprint loss | 3 trace loss           | 4 jump, arm / raw   | gate     |
| ------------- | -------------------- | ---------------------------------- | ---------------- | ---------------------- | ------------------- | -------- |
| joint_wl200   | 65 (0)               | +0.0069, -0.0320 (24 cells): pass  | 0.0054: pass     | 0.0994: does not apply | 0.944 / 0.925: pass | pass     |
| joint_wl24_01 | 50 (0)               | no truth: does not apply           | 0.0305: **fail** | 0.0432: pass           | 0.970 / 1.005: pass | **fail** |
| joint_plain   | 142 (0)              | +0.0020, -0.0057 (135 cells): pass | 0.0001: pass     | 0.0015: does not apply | 0.984 / 0.970: pass | pass     |

Against the same recordings without the replay, and against the nulls (the largest loss of `raw` at half or twice the
budget against `raw`):

| recording | footprint loss without / with the replay | largest null footprint loss without / with | trace loss without / with | QC-pass cells without / with |
| --------- | ---------------------------------------- | ------------------------------------------ | ------------------------- | ---------------------------- |
| wl200     | 0.0052 / 0.0054                          | 0.00025 / 0.00031                          | 0.1039 / 0.0994           | 63 / 65                      |
| wl24_01   | 0.0086 / 0.0305                          | 0.00167 / 0.01433                          | 0.0441 / 0.0432           | 58 / 50                      |
| plain     | 0.0000 / 0.0001                          | 0.00022 / 0.00020                          | 0.0015 / 0.0015           | 142 / 142                    |

**Result for the owner.** The frame replay on factors carries the cluster replay mechanically: it runs, cells are kept,
and on `wl200` and `plain` the gate passes as without it. On the real recording `wl24_01` its footprints differ from the
raw run's by 0.0305, above the 0.02 of rule 2, in both `chosen` and `c_chosen`; the frame engine (`chosen`) fails the
same way, so the factor engine is not the cause. The raw pipeline itself varies near the limit with the replay on: the largest null loss
there is 0.0143 (without the replay 0.00167), so the arm's loss is 2.1 times the largest null and the nulls alone use
72 percent of the limit. The loss is 3.5 times what the same recording gave without the replay. Why it differs is not
known; it was not looked at further (this is not a failure of the factor engine, which does not change footprints).

Engine comparison on these runs (`c_chosen` against `chosen`, rerun of `c_chosen` with the `min_valid` split): same
footprints yes on all three; the rerun's traces are the same bytes as the first run's in all three.

| recording     | cells | trace difference over sd, median / largest | `min_valid` below 1: cells; median / largest | `min_valid` equal to 1; median / largest | largest cell                                    |
| ------------- | ----- | ------------------------------------------ | -------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| joint_wl200   | 72    | 0.0000 / 0.0002                            | 0                                            | 72; 0.0000 / 0.0002                      | cell 65, 73.7 px from the border                |
| joint_wl24_01 | 108   | 0.0152 / 2.0874                            | 9; 0.1040 / 2.0874                           | 99; 0.0145 / 0.0659                      | cell 12 (sd 0.0016, 3 nonzero samples of 12000) |
| joint_plain   | 187   | 0.0002 / 0.0071                            | 0                                            | 187; 0.0002 / 0.0071                     | cell 86, 30.3 px from the border                |

The 2.09 sd of `joint_wl24_01` is a cell with almost no signal (3 nonzero samples; the absolute difference is 0.003),
so the ratio is large because its sd is tiny. The next cell, 41, is a real difference: 1.06 absolute on a trace with
peak 6.9 and sd 1.06, so 1.0000 sd. Both cells are among the nine of `joint_wl24_01` whose `min_valid` is 0 (a support
pixel never valid in some window; cells 12, 35, 41, 42, 43, 44, 66, 67, 115): as on `wl24_04`, the large differences
are in cells with a missing support pixel. The 99 cells at 1 have a median of 0.0145 and a largest of 0.0659, the level
of the WL24 recordings without the replay (0.0162 and 0.0147).

Extract time with the replay on (frames engine against factor engine, wall): `joint_wl200` 18.06 s against 0.48 s;
`joint_wl24_01` 38.00 s against 1.89 s; `joint_plain` 72.05 s against 0.52 s. The raw replay's solving on
`joint_wl24_01` is 16.15 s, about three times the same recording without the replay (5.14 s); the cause was not looked at.

## What was built in the app, and what is untested there

- **Built.** The compress worker's back-fill (`?compress`) solves on a WASM `FactorExtractor` instead of rebuilding
  frames from `FactorWindow` and solving with a `TraceEngine`: 64 frames per yield (was 16), one `traces` message per
  window. The status bar's mean rank is now the mean over the compressed windows, weighted by frames (it was the last
  window's). The app's tests compare the back-fill with the frame engine on the same factors; at implementation the
  largest gap was 5.7e-6 at threshold 0.1 (from the task record; not re-run here).
- **The app's extractor differs from the gate runs in one setting.** The app's `FactorExtractor` runs with the
  consolidated ring gradient off, as its live trace path does; the harness's gate runs (`extract_from_factors`) have it
  on. A unit test covers off (against the frame engine with it off, 2e-4). The gate runs on data do not cover off.
- **A non-full FOV with a ring background:** one edge cell is 2.1e-4 from the frame engine against the test's 2e-4
  tolerance (the cell's own bound is 3e-4). The re-review judged it rounding: the ring pixels are filtered by the FOV
  once, at library build, and both routes read the same ones, and a treatment difference would show as about 1e-2.
  This edge cell has the smallest ring, so the solve amplifies rounding most there.
- **Tested in the browser** only as in the previous section (two recordings, once each, under load). Extract in the app
  still replays the raw file; only the back-fill uses the factor engine.

## What was not measured

- **Missing pixels beyond the split.** B against C with a missing pixel in a moat or ring block on real data (the
  claim about the level on the WL24 recordings is inferred).
- **The app's setting on data.** The factor engine with the consolidated ring gradient off, on a recording.
- **A short last window in the gate runs.** 12000 and 6000 frames divide into 600-frame windows exactly. The unit
  tests and a harness test cover a short window (600 plus 50 frames, a window of 50), the gate runs do not.
- **The browser back-fill, beyond one run each under load:** its longest batch (the longest `solve` call is not
  logged), a time on an idle machine, a before/after against the old back-fill on the same machine state, and its traces
  against the frame engine's on data. Also a live stream: windows arriving while the recording runs.
- **Whole recordings and the full budget.** The runs are the first 12000 or 6000 frames at a tenth of the default
  slow-loop budget.
- **Refine on factors** (phase 3), the low-SNR and dense sets, and a library that changes between windows (the
  extractor refuses a projector built for another library or layout; its use with a library that changes was not
  measured).
- **Spread.** Each configuration ran once (the rerun of `c_chosen` is a second sample only of that arm), so no spread
  of the timings, and the cluster-replay result on `wl24_01` rests on one run per arm.

## Provenance

| item                                                                 | value                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| harness for `raw`, nulls, `chosen`, `c_chosen` first run, joint arms | `qc_eval` built at da6759da (build commit in `run_all.log`; started 22:58, 18 Nov)                                        |
| harness for the rerun of `c_chosen`                                  | built at b6990928 (`bin/BUILT_FROM`), copied to the path the arms' commands name                                          |
| merge of main                                                        | cdccdbab (origin/main 63676444), before the runs                                                                          |
| frame route against phase 1                                          | `raw` and `chosen` traces: same bytes on all six recordings (`cmp`)                                                       |
| rerun against first run                                              | `c_chosen` traces: same bytes on all six gate recordings                                                                  |
| cluster-replay reruns                                                | all three finished; `c_chosen` traces same bytes as the first run in all nine folders (`rerun_c.log`, "rerun done 02:17") |
