# Concurrent settle: settling while Discover runs (19 Nov 2026)

Follow-up to [2026-11-19-lookback-settle.md](2026-11-19-lookback-settle.md) and
[2026-11-19-lookback-settle2.md](2026-11-19-lookback-settle2.md). The end-of-Discover settle (`SETTLE`) freezes the
cell set and feeds one pass of re-read frames through the ordinary `observe`. This study asks whether the same work
can be done during Discover, on a share of the slow loop's compute, so that a live stream has a library close to
settled at every moment and a recording needs little or no settle at the end.

Targets and arms below were written before any result run (commit order shows it). Smoke runs of 2400 frames on
static_s5, used to check that the code runs and that the virtual clock fills idle time, do not count as results.

## Design under test (A: interleaved settle work in the slow loop)

Three ingredients, each behind a default-off switch, on top of the PI's Discover (look-back 2, cluster replay, merge
guard):

1. **Settle visits** (`SlowLoop::step_settle`): refinement-only tile visits on a work budget of their own. The cell
   set is not frozen; the ordinary visits (adds, merges, keep tests) go on in `step` on their own budget.
2. **Re-read frames to the statistics** (`SlowLoop::observe_settle`): saved frames spread evenly over the history
   seen so far (16 in a row, chunks placed by a golden-ratio sequence), solved with the current library, update the
   footprint statistics and cluster stores of every cell. A frame keeps the side it had as a live frame; held-out
   frames never reach fitting.
3. **Re-read frames to the reservoir**: the same frames are offered to the reservoir on their own side, so the test
   frames of the settle visits turn over. The slots they take make tiles due for settle visits only, not for
   ordinary visits (in the settle2 study, look-back frames that made tiles due for ordinary visits added cells).

No frame counter, evidence ledger, probes or noise correlation see a re-read frame. One re-read frame earns one
frame's budget of settle visits, as in `SETTLE`.

**Scheduler** (`SettleSched`): one parameter, the settle's share S of the slow loop's compute. Recording at full speed
(lock-step): every live frame earns S / (1 - S) settle units (S = 0.5: one unit per live frame, the same number of
units as `SETTLE`'s one pass). Stream (`--offered-fps`): the slow worker spends S of its idle time on settle units; a
unit is not interrupted, so a unit in progress makes an arriving batch wait (two forward buffers absorb that).

Design B (a background worker settles a copy of the library and merges footprints back) is kept on paper unless A
fails its screen.

## Arms

Common Discover flags (`D`): `--passes 1 --batch 8 --budget 30000000 --slow-seed 1 --joint-update all --joint-sign all
--lookback 2 --merge-guard-sep 0.6` (sims: the suite's `--dump --no-heldout --no-signed`). End settle doses are tails
branched after Discover (`--branch-after discover`): `S2400`, `S4800`, `S9600` = `--settle-frames N --settle-batch 16`.

| arm         | added to `D`                                    | what it is                                             |
| ----------- | ----------------------------------------------- | ------------------------------------------------------ |
| `LIVE`      | none                                            | Discover only (the library a stream has today)         |
| `SETTLE`    | tail `S9600`                                    | the reference (no drain, as the app now runs it)       |
| `CS-visits` | `--csettle 0.5 --csettle-mode visits`           | ingredient 1                                           |
| `CS-stats`  | `--csettle 0.5 --csettle-mode stats`            | ingredients 1 + 2                                      |
| `CS-full`   | `--csettle 0.5`                                 | ingredients 1 + 2 + 3                                  |
| `CS-late`   | best mode, `--csettle-ramp late`                | same total, all of it in the second half (2 per frame) |
| `CS-quiet`  | best mode, `--csettle-quiet 600`                | no settle visit where the cell set changed < 600 frames ago |
| `CS-33`     | best mode, `--csettle 0.33`                     | half the settle units                                  |
| `T30`, `T20` | `--offered-fps 30 / 20 --csettle 0`            | stream baseline (look-back on the virtual clock)       |
| `T30-CS`, `T20-CS` | `--offered-fps 30 / 20 --csettle 1`, best mode | stream, all idle time to the settle              |

Virtual clock: `--units-per-ms 2e6` (the harness's WASM calibration), `--pool 2`, `--visit-workers 0` (one slow
worker; the app's extra visit workers would only add spare compute, so this is the conservative case), a re-read
frame every 10 ms at most (`--lb-ms`). Checkpoint libraries: `--lib-at 0.25,0.5,0.75`.

## Targets

Suite rules: paired differences per sim, 95 % CI over sims. "Gap" = `SETTLE` minus `LIVE` (stream: the stream
baseline + `S9600` minus the stream baseline).

**T0. Flags off = main.** With no `--csettle` the binary's outputs are byte-identical to main's on static_s5 for
`SETTLE` (lock-step) and for one `--offered-fps 30` run. A branched `--offered-fps` run equals the unbranched one.

**T1. Screen (quick tier, 5 sims; lock-step).** Each `CS-*` arm with no end settle, against `LIVE`:

- Go: closes at least half of the gap on footprint r (all cells) with a CI of (arm minus `LIVE`) that excludes 0, and
  at least half of the gap on bitten footprints (0.75-1 D); born in second half not lower (CI includes 0 or better);
  matched cells within 1 %; false cells not higher (CI includes 0 or lower).
- No-go: less than a quarter of the gap closed on footprint r (all cells), or false cells higher with a CI that
  excludes 0, or matched cells lower by more than 1 %.
- An arm is stopped after 3 sims when it closes less than a quarter of the gap on all three or adds more than 5
  false cells per sim. The ladder `CS-visits` -> `CS-stats` -> `CS-full` says which ingredient carries the gain; the
  simplest mode that passes is "best mode". Schedule arms (`CS-late`, `CS-quiet`, `CS-33`) run only for it.

**T2. Pre-recorded: equal quality at less total settle work.** "Equal to `SETTLE`" (the app drain study's lines):
footprint r all cells >= -0.0005, close pairs >= -0.0010, born in second half >= -0.005, bitten share <= +0.03,
false cells <= +2, matched >= -2 per sim (point estimates; a miss with a CI that includes 0 is "between the lines").

- For each `CS` arm the smallest end dose in {0, 2400, 4800, 9600} at which it equals `SETTLE` is found. Total
  settle units = concurrent units + end dose (`SETTLE`: 9600).
- Go ("less total work"): some arm equals `SETTLE` with at most 0.8 x `SETTLE`'s settle units. Same cost: 0.8-1.1 x.
  No-go: every arm that equals `SETTLE` needs more than 1.1 x.
- Reported with it: slow-loop work units (whole run), re-read frames (they cost preprocessing and a solve outside
  the slow loop's work count), qc_eval wall (noisy under shared load, secondary).
- The deciding arm goes to the full tier (14 sims).

**T3. Stream (quick tier first, deciding arm on the full tier).**

- Dropped frames: 0 in every run, baseline and `CS`, at 30 and at 20 fps. Any drop caused by the settle is a no-go
  for that share. Reported: owner busy share, the share of time on the settle, idle left.
- Live library at the end of the stream, no end settle (`T30-CS` against `T30`): go when at least half of the gap
  is closed on footprint r (all cells) with a CI that excludes 0 and at least half on bitten share; false cells not
  higher (CI includes 0 or lower); matched within 1 %. No-go below a quarter.
- Live library at 25 / 50 / 75 %: footprint r of matched cells, all and those born at least 1200 frames before the
  checkpoint, `CS` against baseline at the same checkpoint. Reported with CI; `CS` must not be lower (CI includes 0
  or better).
- End-of-stream settle still needed: the smallest dose in {0, 2400, 4800, 9600} at which `T30-CS` + dose equals the
  baseline + `S9600` by the T2 lines. Go when at most 4800 (half).
- Stability of the live library: per cell, relative L2 change of the footprint between consecutive checkpoints
  (cells present at both), median and share above 10 %. Reported for `CS` and baseline; no line (a settling library
  must move while it improves; what matters is that the movement falls as the session goes on).

**T4. Real data** (workshop recording, 3 slow seeds; Samara `10_43_21` and `14_57_02`, at least 2 slow seeds each;
`--motion`, `--fps 30` on Samara; stream arms at `--offered-fps 30`). No ground truth; Minian is a reference only.

- Live `CS` library at the end of the stream against the stream baseline and the baseline + end settle: seed-to-seed
  median footprint r (go: at least half of the gap closed), matched share, cell counts (within the baseline's seed
  range), Minian units matched and median r (workshop).
- A Refine after the live `CS` library moves footprints by at most 1.5 x the second-Refine null (settle2 study's
  null: workshop 10 %, Samara 7-8 %): "settled". Above 2 x: not settled. Reported between.
- Dropped frames 0. Change between checkpoints as in T3.

## Results

Binary `qc_eval-cs-b` (this branch at the commit that adds the prototype). Run trees under `$CALA_DATA`:
`runs/concsettle/t0` (byte checks), `demix-suite/cs-q` (lock-step arms, quick tier), `demix-suite/cs-t` (stream arms,
quick tier). Tools: `arm_tree.py` (N arms in one suite tree), `settle_ladder.py`, `concsettle_checkpoints.py`.

### T0. Flags off = main: pass

static_s5, `cmpruns.py` (every output file, wall-time fields masked): `SETTLE` with the drain against the settle2
study's run: identical (18 files). `--offered-fps 30` against `qc_eval-lbs2-b`: identical (18 files). pairs_s5,
`--offered-fps 30 --csettle 1` with and without `--settle-frames 2400`, unbranched against branched after Discover:
identical apart from the wall seconds in `csettle.txt`. Branching is now refused with `--visit-workers` instead of
`--offered-fps`.

### T1. Screen, lock-step, quick tier (5 sims; `demix-suite/cs-q`, `ladder-vs-LIVE.md`, `ladder-vs-SETTLE.md`)

Share 0.5: one settle unit per live frame, 9,535 units per sim. Arm minus `LIVE` [95 % CI]; the gap is `SETTLE`
minus `LIVE`.

| measure                          | `LIVE` | gap to `SETTLE`         | `CS-visits`               | `CS-stats`                | `CS-full`                 |
| -------------------------------- | ------ | ----------------------- | ------------------------- | ------------------------- | ------------------------- |
| footprint r, all cells           | 0.9906 | +0.0027 [0.0021, 0.0036] | +0.0002 [-0.0005, 0.0012] | +0.0026 [0.0019, 0.0034]  | +0.0025 [0.0019, 0.0033]  |
| footprint r, close pairs         | 0.9905 | +0.0031 [0.0021, 0.0043] | +0.0009 [-0.0002, 0.0021] | +0.0028 [0.0018, 0.0039]  | +0.0026 [0.0016, 0.0037]  |
| footprint r, born in second half | 0.9422 | +0.038 [0.024, 0.062]    | +0.022 [0.002, 0.046]     | +0.025 [0.008, 0.050]     | +0.016 [-0.003, 0.044]    |
| footprint r, born in last 20 %   | 0.842  | +0.131 [0.106, 0.181]    | +0.054 [-0.018, 0.112]    | +0.094 [0.035, 0.150]     | +0.085 [0.010, 0.148]     |
| bitten footprints, 0.75-1 D      | 0.271  | -0.129 [-0.178, -0.079]  | -0.022 [-0.076, 0.031]    | -0.089 [-0.142, -0.036]   | -0.068 [-0.120, -0.017]   |
| matched cells per sim            | 346.2  | +3.2 [-0.5, 6.9]         | +2.2 [-2.4, 6.8]          | +1.6 [-4.5, 7.7]          | +5.6 [-3.5, 14.7]         |
| false cells per sim              | 13.6   | -3.2 [-6.9, 0.5]         | +1.8 [-2.0, 5.6]          | +0.6 [-5.6, 6.8]          | +1.6 [-3.6, 6.8]          |

- **`CS-visits`: no-go.** Refinement visits on a budget of their own close 7 % of the gap on footprint r (all
  cells) and 17 % on bitten share. So the settle2 study's reading "what limits footprints during Discover is the
  amount of refinement" is wrong: 9,400 extra refinement visits and 7,700 accepted refinements per sim (static_s5)
  change almost nothing by themselves.
- **`CS-stats`: go.** Re-read frames to the statistics close 96 % of the gap on footprint r (all cells) and 69 % on
  bitten share, with matched and false cells within noise. What the settle adds is the re-estimation of the
  statistics on frames solved with the current library, not more visits and not fresh test frames.
- **`CS-full`: go, and no better than `CS-stats`** (93 % and 53 %; late-born rows lower, not higher). Offering the
  re-read frames to the reservoir adds nothing during Discover, as in the settle2 study: live frames keep the test
  frames fresh. It costs 12 % more slow-loop work (static_s5: 3.54e11 against 3.15e11 units for the settle part).
- **Best mode = `stats`** (the simplest that passes). It needs no change to the reservoir, so no slow-loop index per
  stream frame; the held-out flag the app already records is enough.
- What is left open after `CS-stats`: late-born cells (born in the last 20 %: 0.936 against `SETTLE`'s 0.973) and a
  third of the bites. A cell born near the end has had little settle time; only an end dose can give it that.
- In `stats` mode a held-out re-read frame does nothing (3,323 of 9,535 on static_s5), but the prototype still
  re-reads and solves it. A scheduler that skips them before the solve saves a third of the re-read cost.

Against `SETTLE` (T2 lines: r all >= -0.0005, close pairs >= -0.0010, born second half >= -0.005, bitten <= +0.03,
false <= +2, matched >= -2):

| arm            | settle units (concurrent + end) | r all                      | close pairs                | born second half           | bitten share            | matched / false                      |
| -------------- | ------------------------------- | -------------------------- | -------------------------- | -------------------------- | ----------------------- | ------------------------------------ |
| `LIVE+S4800`   | 0 + 4800 (0.5 x)                | -0.0005 [-0.0010, 0.0000]  | -0.0003 [-0.0011, 0.0004]  | -0.010 [-0.018, -0.000]    | +0.022 [-0.020, 0.067]  | -0.2 / +0.2                          |
| `CS-stats`     | 9535 + 0 (1.0 x)                | -0.0002 [-0.0007, 0.0004]  | -0.0003 [-0.0012, 0.0004]  | -0.013 [-0.024, -0.003]    | +0.039 [-0.007, 0.086]  | -1.6 / +3.8 [-2.2, 9.8]              |
| `CS-stats+S4800` | 9535 + 4800 (1.5 x)           | +0.0003 [-0.0002, 0.0007]  | +0.0002 [-0.0005, 0.0009]  | -0.005 [-0.015, 0.003]     | -0.011 [-0.054, 0.030]  | -1.2 / +3.4 [-2.3, 9.1]              |
| `CS-full`      | 9535 + 0                        | -0.0002 [-0.0008, 0.0003]  | -0.0005 [-0.0013, 0.0002]  | -0.022 [-0.035, -0.005]    | +0.060 [0.015, 0.106]   | +2.4 / +4.8 [-0.5, 10.1]             |
| `CS-full+S2400` | 9535 + 2400                    | -0.0002 [-0.0007, 0.0003]  | -0.0003 [-0.0011, 0.0003]  | -0.010 [-0.022, -0.000]    | +0.039 [-0.007, 0.084]  | +2.6 / +4.6 [0.1, 9.1]               |
| `CS-full+S4800` | 9535 + 4800                    | -0.0000 [-0.0005, 0.0005]  | -0.0001 [-0.0008, 0.0007]  | -0.007 [-0.021, 0.004]     | +0.029 [-0.016, 0.074]  | +3.2 / +4.0 [-0.4, 8.4]              |

- The concurrent settle by itself equals `SETTLE` on the overall rows and misses on late-born cells and bites. With
  half an end pass it equals `SETTLE` on every footprint row. False cells read 3-5 higher than `SETTLE`'s in every
  `CS` arm with CIs that include 0 (the Discover of a `CS` arm is a different run from `LIVE`'s; `SETTLE` turns about
  3 "false" cells per sim into matched ones by lifting their r above 0.7, and the `CS` arms do not show that).
- Half an end pass alone (`LIVE+S4800`) is already within 0.0005 of `SETTLE` overall and misses only on late-born
  cells. So at share 0.5 the concurrent settle is not cheaper in total than settling at the end.

(more below as the runs finish)
