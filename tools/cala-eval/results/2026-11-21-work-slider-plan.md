# Target processing rate slider: benchmark plan (committed before any run)

21 Nov 2026. Branch `eval/cala-work-slider` ("PR 2" of the work-slider design,
`~/Projects/cala-data/demix-bench/work_slider_design.md`, section 5). This file holds the arms, the measures and every
pass line (L1-L9, C1) **before any run they judge**; commit order is the proof. Changes made after a run are marked
"(changed after a run: ...)". Results go in `2026-11-21-work-slider.md`.

Numbers in this file come from earlier measurements: **(Chrome)** = headed Chrome, this machine (18 cores, Metal GPU, 4
visit workers), `2026-11-21-csettle-app.md`; **(model)** = qc_eval's virtual clock, `2026-11-20-concurrent-settle2.md`
and `2026-11-21-concurrent-settle3.md`.

## Names (PI, 21 Nov 2026)

Stages: Discover -> Final settle -> Extract. Kinds of frame work: **Live** (fast loop, per frame), **Discovery** (slow
loop + visit workers), **Look-back** (need-driven re-reads for new cells), **Background settle** (settle during
Discover on spare compute; qc_eval `--csettle`, app `?csettle`), **Final settle** (after Discover; qc_eval
`--settle-frames`), **Spare**. Flags and identifiers keep their names. (Terminology edit after the first commit of
this file, before any run.)

## PI decisions this plan follows (21 Nov 2026, "go with your defaults")

- Parity with "Max" is judged on Max's repeatable cells and their footprints (lines L2, L2b); extra cells are reported
  separately (L2c, no gate).
- The slider unit is fps, with x real time beside it; the floor is 10 fps.
- The default settle cap is 2 re-read frames per live frame. Arms at 4 and 8 are tested before raising it (L9).
- The full final settle is kept at every slider position until a shrink rule is validated.
- Whether to add a second look-back worker is decided after the paced Chrome runs of step 0b (and line L8 later).
- "Max" = no pacing, no background settle, full final settle (today's recording path).

## Step 0: calibrate qc_eval against Chrome

The model was built for a 30 fps stream. Known gaps before this PR:

| quantity                                                     | model                                                            | Chrome                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| visit jobs in Discover, Samara `10_43_21`, 30 fps, no settle | 71,000-73,000                                                    | 51,000-55,000                                                                                                                            |
| time per re-read frame on the look-back worker               | 5 ms (`--lb-ms 5`, round 2-3; flag default 10)                   | 8-11 ms (90-125 re-read frames a second while Discover runs)                                                                             |
| need-driven look-back                                        | applied at the live frame, never limited by the look-back worker | one 16-frame request out at a time; at full speed the worker is the limit (workshop 10,300 asked, about a third of 2 per observed frame) |
| look-back worker timing                                      | `--lb-ms` per frame                                              | not reported by the app; inferred from throughput                                                                                        |

Method:

- Cost parameters become flags (or defaults behind flags); **with every new flag off, qc_eval output is
  byte-identical to main** (all output files, wall-time fields masked; `cmp_runs.py`, static_s5, 4800 frames, at least
  the `V30` and `CS2F` configurations of round 2).
- Runs: the baseline (`--offered-fps F --visit-workers 4 --pool 4`, look-back on, `--csettle 0`) and `CS2F`
  (`--csettle 0.667 --csettle-mode frames`) at F = 30 and at the Chrome full-speed rates (workshop 218, Samara
  `10_43_21` 338, `14_57_02` 345), slow seed 1, the three recordings, full length.
- **Adjust on the workshop recording only**: its full-speed Chrome runs and its two step-0b paced runs (60 and 120
  fps; the only workshop data where the slow loop is not saturated). Parameters set there are not changed again for
  the check on Samara; the Samara step-0b runs (60, 120 fps) are comparison points only. Iteration may use a prefix of
  the recording against the Chrome counters at the same frame (the logs sample them every 5 s); the verdict runs are
  full length.
- The model is documented against `apps/cala/src/lib/slow-runner.ts` (what each modelled cost stands for in the app).

**Calibration line C1:** on the two Samara recordings (not used for the adjustment), model against Chrome **within 15 %
on each of**:

1. frames the slow loop misses (in points: within 3);
2. visit jobs in Discover;
3. need-driven look-back frames asked;
4. background-settle frames per live frame (arm `CS2F` against the app's toggle on).

Chrome reference values (mean of the runs in `2026-11-21-csettle-app.md`; toggle-on rows from after the preprocessor
fix where they exist):

| recording, rate        | arm | missed by slow loop | visit jobs | need-driven asked | background settle per live frame |
| ---------------------- | --- | ------------------- | ---------- | ----------------- | -------------------------------- |
| `10_43_21`, 30 fps     | off | 0 %                 | 54,849     | 35,415            | -                                |
| `10_43_21`, 30 fps     | on  | 0 %                 | 51,257     | 35,415            | 1.99                             |
| `14_57_02`, 30 fps     | off | 0 %                 | 51,340     | 35,407            | -                                |
| `14_57_02`, 30 fps     | on  | 0 %                 | 49,810     | 35,407            | 1.99                             |
| `10_43_21`, full (338) | off | 19.5 %              | 3,669      | 6,656             | -                                |
| `10_43_21`, full (337) | on  | 22.2 %              | 3,459      | 2,920             | 0.215                            |
| `14_57_02`, full (345) | off | 14.9 %              | 3,903      | 6,464             | -                                |
| `14_57_02`, full (343) | on  | 15.9 %              | 3,699      | 2,832             | 0.19                             |
| workshop, full (219)   | off | 33.4 %              | 4,628      | 10,320            | - (adjustment only)              |
| workshop, full (216)   | on  | 38.2 %              | ~3,800     | 4,912             | 0.335 (adjustment only)          |

The full-speed toggle-on rows of Samara predate the preprocessor fix (no later full-speed Samara run exists); the fix
did not change the workshop full-speed numbers, where the look-back worker is the limit.

How C1 is read:

- **C1 at 30 fps** = the four 30 fps rows; **C1 at full speed** = the four full-speed rows. Each row and measure is
  judged on its own; a measure with Chrome value 0 % is judged by the 3-point rule only.
- **If C1 passes at 30 fps only:** qc_eval is used up to 60 fps; faster targets are Chrome-only.
- **If C1 fails at 30 fps:** stop and report before any slider arm is run in qc_eval.
- The step-0b Chrome runs (60 and 120 fps) are added as extra comparison points once they exist; they are reported
  next to C1 and do not change its verdict.

## Step 0b: the one-worker dose in the middle of the range (Chrome, 4 runs)

`main` as it is (PR #454 merged), `?lookback&csettle&debug&pacefps=N` with N = 60 and 120, Samara `10_43_21` and the
workshop recording, one run each (repeats if time allows). Headed Chrome, real GPU, dev server on port 5198,
`apps/cala/scripts/memory-measure.mjs --single --lookback --csettle --pacefps N --headed`. Today's pacer is bursty;
the dose over a whole run does not depend on that.

Read per run: background-settle frames per live frame (delivered dose), need-driven frames asked, look-back frames per second
(need-driven + background settle, over Discover), frames missed by the slow loop, achieved fps, the slow worker's mean and
longest time per background-settle answer, visit jobs, the final settle's moved share (cells above 2x and 1x their noise, median
change).

Compared with the design's estimate (one worker taking turns: dose about 55 / target per live frame, so 0.9 at 60
fps and 0.46 at 120; the slow-worker ceiling on the workshop recording 2.9 at 60 and 0.4 at 120).

No pass line (a sizing measurement). **Decision rule for a second, dedicated background-settle look-back worker, written before
the runs:**

- **Warranted** if at 60 fps, on both recordings, the delivered dose is below 1.5 (75 % of the cap of 2) and the
  look-back worker is the limit there (need-driven + background-settle re-reads at or above 90 frames a second, the rate it
  managed beside a full-speed Discover) while the slow loop misses at most 1 % of the frames (it has room for more
  answers).
- **Not warranted** if the delivered dose at 60 fps is at least 1.8 on both recordings (one worker covers the range up
  to 60 fps), or if the slow loop, not the look-back worker, is the limit (misses above 1 % with the dose below the
  cap).
- Otherwise: undecided, reported with the numbers; line L8 decides later.
- At 120 fps the same reading is reported; the design expects the slow worker to be the limit on the workshop
  recording there.

## What qc_eval can model, and what needs Chrome

| question                                                            | qc_eval (virtual clock)                                    | headed Chrome                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| Final quality at a fixed rate, with seeds and CIs                   | yes                                                        | 2-3 repeat runs, no seeds                    |
| Ground truth (sims)                                                 | yes                                                        | no                                           |
| Live-library quality at checkpoints                                 | yes                                                        | only via the saved library at the last frame |
| Final-settle dose-response (branches)                               | yes                                                        | no (one budget per run)                      |
| Frames the slow loop misses, batch waits                            | yes, after C1                                              | yes                                          |
| Several look-back workers                                           | needs a small flag (`--lb-workers`, each on its own clock) | yes, after the pool is built                 |
| Discover's max rate, its fall as cells accumulate, the max estimate | no (the fast loop is not modelled)                         | yes                                          |
| Whether the fast loop holds the target beside the other workers     | no                                                         | yes                                          |
| Evenness of the pacing, hidden tab                                  | no                                                         | yes                                          |
| Memory, time on the wall                                            | no                                                         | yes                                          |

## Arms

Rates: **Max, 120, 60, 30, 20 fps.** In qc_eval, "Max" is the offered rate Chrome reached on that recording. The
model's `S-f` arms use a fixed dose (the cap, as delivered by the modelled look-back workers); the governor's guard is
not in the model and is tested in Chrome only.

| arm                                                      | rate            | background settle                                                     | final settle                  | purpose                                 |
| -------------------------------------------------------- | --------------- | --------------------------------------------------------------------- | ----------------------------- | --------------------------------------- |
| `REF`                                                    | Max             | off                                                                   | full pass                     | reference (today's path)                |
| `P-f`                                                    | 120, 60, 30, 20 | off                                                                   | full pass                     | what the pace alone does                |
| `S-f`                                                    | 120, 60, 30, 20 | governor, cap 2, 1 need-driven + 1 background-settle look-back worker | full pass                     | the slider                              |
| `S-f-1w`                                                 | 120, 60, 30     | cap 2, one worker taking turns (today's #454)                         | full pass                     | is the second worker worth it           |
| `S30-c4`, `S30-c8`, `S20-c8`                             | 30, 20          | cap 4 and 8                                                           | full pass                     | doses above 2; the floor                |
| branches of every `REF`, `P-30`, `S-30`, `S-60`, `S-120` | -               | -                                                                     | 0, 1/4, 1/2, 3/4, 1, 2 passes | dose-response for the final-settle rule |

Data and repeats:

- **Real, qc_eval:** workshop, Samara `10_43_21`, Samara `14_57_02` (read-only), **3 seeds each** (`--slow-seed`).
- **Sims, qc_eval:** the quick tier (5 sims, seeds 5-9, `~/Projects/cala-data`, `source sims.env`). The arms that decide
  a line (`REF`, `S-30`, `S-60`, `P-30`) are repeated on the 14-sim tier.
- **Chrome:** `REF`, `P-30`, `S-30`, `S-60`, `S-120` on the three recordings, **2 runs per arm, 3 for `REF`**. Runs
  interleaved in both orders. One Chrome at a time, headed, real GPU, port 5198.
- **Order of work:** step 0; then tier 1 = `REF`, `P-30`, `S-30`, `S-60` on real and quick sims, each with branches;
  read; then the rest. A smoke run sets the wall time per run before a tier is launched. Machine rules: at most 6 light
  runs at once machine-wide, at least 5 GB free, RAM budget 6 GB per run.

## Measures

1. **Final quality against `REF`** (after the final settle):
   - sims: footprint r with ground truth (all cells, close pairs, cells born in the second half), bitten footprints,
     matched and false cells;
   - real: median footprint agreement of matched cells between the arm and `REF` of the same seed, and between two
     seeds of the same arm; the null is `REF` against `REF` across seeds;
   - cells: how many of `REF`'s repeatable cells (in at least 2 of 3 `REF` seeds) the arm has; the arm's extra cells
     with their held-out z, peak SNR, birth frame and, on the workshop recording, whether a Minian unit matches
     (agreement, not recall).
2. **Total time:** Discover + final settle. In qc_eval as virtual time; in Chrome on the wall.
3. **Live-library quality during the run**, at 1/8, 1/4, 1/2, 3/4 of the recording and at the last frame (by position
   in the recording):
   - sims: median footprint r with ground truth, recall;
   - real: agreement with the settled `REF` library of the same seed; share of the gap between `REF`'s live and settled
     library that is closed; what the final settle still moves (cells above 1x and 2x their noise).
4. **Dropped frames:** by the fast loop (must be none); missed by the slow loop; the longest wait of a batch.
5. **Footprint movement:** median change per 75 s of stream in the second half; the moving share at the last
   final-settle checkpoint.
6. **Scheduler:** achieved against target fps; background-settle frames per live frame; the limiting factor over time.

## Pass lines

Differences are arm minus `REF`, paired by sim or by recording-seed, with 95 % CIs. Sims: paired t over sims. Real: per
recording the mean and range over 3 seeds, and a pooled paired bootstrap over the 9 recording-seeds (seeds of one
recording are not independent, so that interval is too narrow; the per-recording rows decide a borderline case).

| line | measure                                                                 | passes when                                                                                                                                            | applies to         |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| L1   | final footprint r, sims, all cells                                      | lower CI bound >= -0.0005, judged on the 14-sim tier (the quick tier only screens: a mean below -0.001 stops the arm)                                  | every `S-f`, `P-f` |
| L1b  | final footprint r, cells born in the second half                        | lower CI bound >= -0.005                                                                                                                               | every `S-f`, `P-f` |
| L1c  | bitten footprints, sims                                                 | upper CI bound <= +0.02                                                                                                                                | every `S-f`, `P-f` |
| L1d  | false cells per sim                                                     | upper CI bound <= +3                                                                                                                                   | every `S-f`, `P-f` |
| L2   | final agreement with `REF`, real (on `REF`'s matched cells)             | >= the `REF`-`REF` null minus 0.003, on each recording                                                                                                 | every `S-f`, `P-f` |
| L2b  | `REF`'s repeatable cells present                                        | >= the null minus 3 points on each recording. Null: the share of the cells two `REF` seeds agree on that the third `REF` seed has (leave one seed out) | every `S-f`, `P-f` |
| L2c  | extra cells (reported; PI: not a gate)                                  | their median held-out z >= that of cells only one `REF` seed has                                                                                       | every `S-f`, `P-f` |
| L3   | live library at the last frame, share of the live-to-settled gap closed | >= 50 % on each recording at 30 fps                                                                                                                    | `S-30`             |
| L3b  | the slider is monotone: live agreement at each checkpoint from 1/4 on   | `S-30` >= `S-60` >= `S-120` >= `REF`, each step allowed to miss by the seed spread (0.003)                                                             | `S-f`              |
| L3c  | the background settle, not the pace, carries it                         | `S-30` minus `P-30` in gap closed: lower CI bound > 0                                                                                                  | `S-30`, `P-30`     |
| L4   | frames dropped by the fast loop                                         | 0                                                                                                                                                      | every arm          |
| L4b  | frames the slow loop misses                                             | <= 0.1 % at 60 fps and below; at 120, <= `P-120` + 1 point                                                                                             | `S-f`              |
| L5   | moving share at the last final-settle checkpoint                        | <= 4 % (<= 6 % on motion sims)                                                                                                                         | every arm          |
| L5b  | footprint movement per 75 s during Discover                             | reported, no line                                                                                                                                      | `S-f`              |
| L6   | achieved fps (Chrome)                                                   | within 2 % of the target when the target <= 0.9 x the measured max                                                                                     | `S-f`, `P-f`       |
| L6b  | total time (Chrome)                                                     | at Max within 3 % of today's path; below Max <= frames / target + `REF`'s final settle + 5 %                                                           | every arm          |
| L7   | max estimate while paced at 30 fps (Chrome)                             | within 15 % of the unpaced rate at the same point of the recording                                                                                     | `P-30`, `REF`      |
| L8   | second look-back worker                                                 | `S-60` minus `S-60-1w` in gap closed: lower CI bound > 0; if not, ship one worker                                                                      | `S-60`             |
| L9   | doses above 2                                                           | cap 4 or 8 minus cap 2 in gap closed: lower CI bound > 0, and L1-L2b still pass                                                                        | `S30-c4`, `S30-c8` |

What decides what:

- L1, L2, L2b, L4, L5 pass at a rate: that rate is safe to offer.
- L3, L3b, L3c pass: the slider does what it promises (a better live library for more time).
- L8 and L9 size the build (workers, cap values, the floor).
- The final-settle shrink lines (design section 3) decide whether the final settle may shrink; until then the full pass is
  kept everywhere (PI decision).

## Scope of this PR

Step 0 (C1), step 0b (four paced Chrome runs), and, if time allows, the qc_eval slider arms `REF`, `P-f`, `S-f-1w` at
120, 60, 30, 20 fps on the three real recordings with 3 seeds (the two-worker `S-f` arm needs `--lb-workers`; it is run
only if that flag lands here). No app code changes.
