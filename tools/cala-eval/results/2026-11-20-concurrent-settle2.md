# Concurrent settle, round 2: settle visits on the visit workers (20 Nov 2026)

Follow-up to [2026-11-19-concurrent-settle.md](2026-11-19-concurrent-settle.md) (round 1, PR #450). Round 1 passed on
the sims and missed on the three real recordings: 15-36 % of the gap closed, a 24-frame stretch dropped in two of
four Samara runs, footprints kept moving. Its virtual clock had one slow worker doing everything. This round puts the
settle visits on the app's visit workers, models those workers and the look-back worker on the virtual clock, and
measures on the real recordings first.

Targets, arms and the model below were written before any result run (commit order shows it). Smoke runs (2400 frames
of static_s5 and of the workshop recording), used to check that the code runs and to read wall time and peak memory,
do not count as results.

## What changed in the design (still design A)

1. **Settle visits are jobs on the visit workers** (`SlowLoop::take_settle_job`): the same refinement-only visit as
   round 1's `step_settle`, through the existing job protocol. A visit worker gets one only when no ordinary visit
   is due for it. A tile is passed over when it is itself due for an ordinary visit or when its zone reaches a tile
   that is. The tile's ordinary visit state (due counter, visit number, probes) is not touched. A unit test checks
   that a settle job through a runner and the byte encoding equals the owner's own settle visit.
2. **The slow worker only takes the statistics update of the re-read frames** (`observe_settle`, round 1's `stats`
   mode). Held-out re-read frames are no longer solved (in `stats` mode they did nothing).
3. **The re-read frames stay on the look-back worker.** They are not moved to the visit workers: a visit worker
   holds no frame source, no preprocessor and no trace engine, and the look-back worker already does this off the
   slow worker.
4. **Quiet period** (`--csettle-quiet F`, round 1): no settle visit on a tile whose cell set changed in the last F
   frames. With jobs the tile's clock is also set by ordinary job results that added, merged, split, absorbed or
   deleted a cell.

Schedule: every live frame the slow worker observes earns R re-read frames (`--csettle S`, R = S / (1 - S)); each
re-read frame earns one frame's budget of settle visits, as in round 1 and in `SETTLE`.

## The model against the app

`qc_eval --offered-fps 30 --visit-workers 4 --pool 4` (`Timed`), against `apps/cala/src/lib/slow-runner.ts`,
`slow-client.ts` and the workers:

| app                                                                                                                      | model                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visit workers: cores minus 5 reserved threads, at most 4 (`visitWorkerCount`): 4 on a machine with 9 or more cores       | `--visit-workers 4`. A machine with fewer cores has fewer; with 5 or fewer the slow worker visits itself (round 1's model).                                                           |
| The slow worker observes each batch and hands a visit to every idle worker after each batch and each result (`dispatch`) | the same order: one message at a time, hand-out after each; one visit out per worker (`--visit-depth 1`, the app's `busy` flag)                                                       |
| A visit costs the worker its compute; the slow worker pays encode, copy and decode per job                               | work units at `--units-per-ms 2e6` (the harness's WASM calibration) on the worker, plus `--job-ms 1` on each side (the harness default; not re-measured with cluster stores in a job) |
| Forward buffers: 4 with visit workers (`PARALLEL_FORWARD_BUFFERS`); a batch with no free buffer is dropped               | `--pool 4`; `--batch 8`                                                                                                                                                               |
| `housekeep` (trimming, publishing) on the slow worker after each message                                                 | the same call, charged its work units                                                                                                                                                 |
| Look-back worker: one request out at a time, at most 16 frames, re-reads, preprocesses and solves                        | settle requests: one out at a time, 16 frames, answered `--lb-ms` per frame after the worker's earlier work; the answer is one slow-worker message that costs all its fitting frames  |
| Look-back worker speed: about 200 frames per second during Discover on the workshop recording (look-back review)         | `--lb-ms 5` (round 1 used 10)                                                                                                                                                         |
| Need-driven look-back (2 frames per live frame at most) shares the look-back worker                                      | applied at the live frame as in round 1 (not delayed), slow worker charged its statistics work; the look-back worker's time is booked for it, ahead of settle requests                |
| A look-back answer was solved with the library the look-back worker had when it started                                  | solved with the library at the moment the answer is handled (up to 80 ms newer)                                                                                                       |
| Settle visits: not in the app                                                                                            | after `take_job` returns nothing for a worker, `take_settle_job`                                                                                                                      |

Not in the model: contention with the fast pipeline's workers and the main thread, garbage collection, message
latency, memory. The end settle after the stream is not timed (it runs after the last frame in both arms).

## Arms

Real recordings, stream at 30 fps. Common flags (`D`): `--motion --batch 8 --budget 30000000 --slow-seed N --passes 1
--joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6 --offered-fps 30 --visit-workers 4 --pool 4
--lb-ms 5 --lib-at 0.125,..,0.875`, then one end settle pass with libraries (`--settle-frames 18000 --settle-batch 16
--settle-libs --settle-check 1800`). Workshop: `--frames 18000`, slow seeds 1-3. Samara `10_43_21` and `14_57_02`:
`--fps 30`, slow seeds 1-2.

| arm       | added to `D`                                               | what it is                                              |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| `V30`     | `--csettle 0`                                              | baseline: the app's Discover with 4 visit workers       |
| `CS2`     | `--csettle 0.667 --csettle-mode stats`                     | 2 re-read frames per live frame, settle visits as jobs  |
| `CS2-Q`   | `--csettle 0.667 --csettle-mode stats --csettle-quiet 600` | the same, only on tiles stable for 600 frames (20 s)    |
| `CS1`     | `--csettle 0.5 --csettle-mode stats`                       | 1 per live frame; workshop seeds 1-2 only (sensitivity) |
| `CS2-Q18` | as `CS2-Q` with `--csettle-quiet 1800`                     | workshop seeds 1-2 only (sensitivity)                   |

The two sensitivity arms were cut to the workshop recording after the smoke run showed the cost of a run with four
visit workers (about an hour for the workshop recording); they are reported and cannot be the chosen arm. This
change was made before any result run.

"Live" = the library at the end of the stream (`settle0`). "Settled" = the same run after the end pass (`final`).

## Targets

"Gap" on a recording = seed-to-seed median footprint r of `V30` settled minus `V30` live (`lookback_settled.py`,
Hungarian match at r >= 0.7, as round 1), mean over the seed pairs. An arm's share of the gap = (its live seed-to-seed
r minus `V30`'s live) / gap.

**T0. Flags off = main** (binary `qc_eval-main-f184a49d`), static_s5 (first 4800 frames), every output file, wall-time fields masked:
`SETTLE` lock-step; `--offered-fps 30 --visit-workers 4` (no `--csettle`); round 1's `--offered-fps 30 --csettle
0.75 --csettle-mode stats` (no visit workers). And on this branch: `CS2` branched after Discover equals unbranched.

**R1. Dropped frames: 0 in every real run**, `V30` and `CS` (7 runs per full arm). Any dropped frame in a `CS` run is a
no-go for that arm. If `V30` itself drops frames on a recording, the line is missed there for the app model as a
whole and is reported as such (a `CS` arm is then judged on "no more than `V30`", and the verdict says so).

**R2. Live library: at least 50 % of the gap closed** on each of the three recordings by one and the same arm (go).
Below 25 % on any recording: no-go. Between: reported as between the lines. Also reported: the paired difference
(arm minus `V30`, live seed-to-seed r) over the 5 seed pairs with a 95 % CI (the three workshop pairs share seeds;
stated with the number), cells per run (within `V30`'s seed range +/- 3 %), Minian units matched and median r
(workshop; reference only).

**R3. Footprint movement suitable for closed-loop.** Median relative L2 change of a cell's footprint between
consecutive checkpoints (2250 frames, 75 s) in the second half of the session (the checkpoints at 0.625, 0.75,
0.875 and the end), mean over those four and over seeds:

- go: at most 12 % on each recording. 12 % is the split-half footprint noise of a settled library on these
  recordings (settle2 study: 11-13 %): the library then moves less in 75 s than two estimates of the same footprint
  from two halves of the data differ.
- no-go: above 18 % (1.5 times that) on any recording. Between: reported.
- Reported next to it: `V30`'s own movement and the paired difference.

**R4. Discover is not held back.** Ordinary visits and added cells of a `CS` run within 5 % of `V30`'s mean on the
same recording (settle jobs hold zones; a miss means the settle slowed Discover's own visits).

**Chosen arm.** Among `CS2` and `CS2-Q` with R1 met: the highest mean share of the gap over the three
recordings. The verdict for the app is go only if that one arm meets R1-R4 on all three recordings. All arms are
reported. The quiet period is "chosen on real data" by this rule; with 2-3 seeds the choice between close arms is
not reliable and is reported as such.

**R5. Total work against the end settle (reported, no line).** Slow-loop work units of Discover (slow worker and
visit workers), re-read frames, and the end-settle dose (in steps of 1800 frames) at which each arm's seed-to-seed r
reaches `V30`'s settled value minus 0.002. Total = Discover work + that part of the end pass, against `V30` + the
full end pass.

**S1. Sims do not regress** (quick tier, 5 sims, `--offered-fps 30 --visit-workers 4 --pool 4 --lb-ms 5`; the chosen
arm and `V30`, each with tails none and `S9600`, branched after Discover). Paired per sim, 95 % CI:

- dropped frames 0 in every run;
- chosen arm minus `V30`, live: footprint r (all cells) not lower (CI includes 0 or above), false cells not higher
  (CI includes 0 or below), matched cells within 1 %;
- reported: share of the gap (`V30+S9600` minus `V30`) closed on footprint r and on bitten footprints, late-born
  cells, slow-worker and visit-worker busy shares.

## Arm added after the first results (not in the targets; same lines applied)

Written when 14 of the 25 runs had finished and one recording (Samara `10_43_21`, `V30` and `CS2`, both seeds) had
been read: there the settle jobs accepted 82 refinements out of 17,316 jobs, and `CS2` made 10 % fewer ordinary
visits than `V30` (line R4: 5 %).

| arm    | added to `D`                            | what it is                                                                   |
| ------ | --------------------------------------- | ---------------------------------------------------------------------------- |
| `CS2F` | `--csettle 0.667 --csettle-mode frames` | the re-read frames of `CS2` with no settle jobs (the ordinary visits refine) |

All seven recording-seeds. It is judged by R1-R4 like the others but is not eligible as the pre-registered "chosen
arm"; if it is the only arm that meets every line, the verdict says so and says that it was added after seeing data.

## Results

Binary `qc_eval-cs2-b` (this branch at the commit that adds the prototype; later commits change tests and tools
only: a build at the branch head is byte-identical to it). Run trees under `$CALA_DATA`: `runs/concsettle2/t0` (byte checks), `runs/concsettle2/real` (32 real runs;
`*_agreement.md`, `*_checkpoints.md`, `*_runs.txt`, `*_summary.json`), `demix-suite/cs2-q` (sims). Tools:
`concsettle2_real.sh`, `concsettle2_summary.py`, `concsettle2_sims.sh`, `cmp_runs.py`. The laptop slept for about an
hour during the runs (wall times of that batch are not comparable; results are on the virtual clock).

### T0. Flags off = main: pass

`cmp_runs.py`, static_s5, first 4800 frames, against `qc_eval-main-f184a49d`: `SETTLE` lock-step (19 files),
`--offered-fps 30 --visit-workers 4 --pool 4` (19 files) and round 1's `--offered-fps 30 --csettle 0.75
--csettle-mode stats` (20 files) are identical apart from wall-time fields. `CS2` with four visit workers, branched
after Discover, equals the unbranched run (21 files). Branching is now allowed with `--visit-workers` when
`--csettle` is given (the slow worker finishes every visit out before the branch point).

### R1-R4. Real recordings, stream at 30 fps with four visit workers

Seed-to-seed r of the baseline: workshop live 0.9474, settled 0.9733 (gap 0.0259); `10_43_21` 0.9791 and 0.9891
(gap 0.0100); `14_57_02` 0.9699 and 0.9863 (gap 0.0164).

| recording  | arm (runs)    | dropped frames | slow worker busy; longest wait of a batch | live seed-to-seed r (per seed pair) | share of gap | footprint change per 2250 frames, second half | split-half noise, live | cells per seed  | ordinary visits; adds, against `V30` |
| ---------- | ------------- | -------------- | ----------------------------------------- | ----------------------------------- | ------------ | --------------------------------------------- | ---------------------- | --------------- | ------------------------------------ |
| workshop   | `V30` (3)     | 0 / 0 / 0      | 33 %; 1.9 ms                              | 0.9458 / 0.9512 / 0.9453            | 0            | 18.9 %                                        | 16.3 %                 | 952 / 956 / 954 | 44,485; 1,163                        |
|            | `CS2` (3)     | 0 / 0 / 0      | 60 %; 44.8 ms                             | 0.9679 / 0.9651 / 0.9687            | **77 %**     | 16.1 %                                        | 10.2 %                 | 904 / 923 / 906 | -13.7 %; -8.5 %                      |
|            | `CS2-Q` (3)   | 0 / 0 / 0      | 59 %; 48.2 ms                             | 0.9682 / 0.9669 / 0.9664            | 76 %         | 16.8 %                                        | 10.1 %                 | 909 / 917 / 916 | -14.5 %; -9.1 %                      |
|            | `CS2F` (3)    | 0 / 0 / 0      | 59 %; 53.0 ms                             | 0.9682 / 0.9705 / 0.9668            | 81 %         | 15.6 %                                        | 10.3 %                 | 923 / 916 / 925 | -14.3 %; -9.3 %                      |
|            | `CS1` (2)     | 0 / 0          | 46 %; 34.7 ms                             | 0.9640                              | 64 %         | 19.1 %                                        | 11.8 %                 | 926 / 921       | -7.7 %; -6.2 %                       |
|            | `CS2-Q18` (2) | 0 / 0          | 60 %; 48.2 ms                             | 0.9685                              | 81 %         | 16.5 %                                        | 10.1 %                 | 905 / 917       | -14.1 %; -8.6 %                      |
| `10_43_21` | `V30` (2)     | 0 / 0          | 25 %; 1.9 ms                              | 0.9791                              | 0            | 11.3 %                                        | 14.3 %                 | 385 / 382       | 89,646; 444                          |
|            | `CS2` (2)     | 0 / 0          | 36 %; 2.7 ms                              | 0.9869                              | **78 %**     | 10.6 %                                        | 9.6 %                  | 380 / 389       | -9.7 %; -5.7 %                       |
|            | `CS2-Q` (2)   | 0 / 0          | 36 %; 2.3 ms                              | 0.9825                              | 34 %         | 11.6 %                                        | 9.7 %                  | 386 / 394       | -10.3 %; -2.7 %                      |
|            | `CS2F` (2)    | 0 / 0          | 34 %; 1.9 ms                              | 0.9861                              | 70 %         | 11.2 %                                        | 10.0 %                 | 391 / 399       | -13.3 %; -3.3 %                      |
| `14_57_02` | `V30` (2)     | 0 / 0          | 25 %; 2.0 ms                              | 0.9699                              | 0            | 11.1 %                                        | 15.4 %                 | 318 / 335       | 93,101; 348                          |
|            | `CS2` (2)     | 0 / 0          | 36 %; 5.2 ms                              | 0.9822                              | **75 %**     | 13.6 %                                        | 10.3 %                 | 320 / 326       | -9.8 %; -1.0 %                       |
|            | `CS2-Q` (2)   | 0 / 0          | 36 %; 4.7 ms                              | 0.9820                              | 74 %         | 13.5 %                                        | 10.6 %                 | 327 / 326       | -10.9 %; -1.6 %                      |
|            | `CS2F` (2)    | 0 / 0          | 32 %; 4.7 ms                              | 0.9827                              | 78 %         | 13.7 %                                        | 10.7 %                 | 315 / 326       | -8.3 %; -2.6 %                       |

In every `CS2*` run the look-back worker delivered the 2.00 re-read frames per live frame asked for (about 35,900
per run, a third of them held out and not solved) at 60 % of its time; the visit workers were 64-74 % busy in every
arm, `V30` included.

- **R1, dropped frames: met.** 0 in all 32 runs. The baseline with four visit workers drops nothing on the workshop
  recording either (round 1's single-worker model dropped 8 % there). The longest a batch waited for the slow worker
  was 53 ms; four buffers cover about 800 ms.
- **R2, live library: met by `CS2`** on each recording: 77 %, 78 % and 75 % of the gap (line: 50 %). Arm minus
  `V30` over the five seed pairs: +0.0159 [0.0076, 0.0242] (95 % CI, paired t; the three workshop pairs share
  seeds). `CS2-Q` reads 76 %, 34 % and 74 %: between the lines on `10_43_21`.
- **How sure is a share on a Samara recording?** One seed pair each. `CS2`, `CS2-Q` and `CS2F` are nearly the same
  algorithm here (see below), and on `10_43_21` they read 78, 34 and 70 %: the spread of one seed pair is of that
  size. Their mean is 61 % on `10_43_21` and 76 % on `14_57_02`; on the workshop recording (three pairs) the three
  arms read 76-81 %.
- **A second measure agrees on two recordings and not on the third.** Median r of a live library against the same
  seed's settled baseline (round 1 used it as evidence for its no-go), `V30` to `CS2`: workshop 0.9547 to 0.9657,
  `10_43_21` 0.9806 to 0.9838, `14_57_02` 0.9780 to 0.9785. On `14_57_02` it shows no gain where seed agreement
  shows 75 %. The baseline's value is against its own run's end pass (same cell set), the arm's against another run,
  which favours the baseline.
- **Fewer cells could flatter the workshop number, not the Samara ones.** The measure is the median r of matched
  cells, and an arm that keeps fewer doubtful cells can gain by that alone. Seed pair 1-2, live: workshop `V30`
  matches 786 of 952 / 956 cells, `CS2` 774 of 904 / 923; `10_43_21` 322 of 385 / 382 against 336 of 380 / 389;
  `14_57_02` 287 of 318 / 335 against 284 of 320 / 326. On Samara the cell counts are equal and the shares are the
  same size as on the workshop recording.
- **R3, footprint movement: not met as written.** Line: at most 12 % per 2250 frames in the second half (no-go
  above 18 %). `CS2`: 10.6 % on `10_43_21` (met), 13.6 % on `14_57_02` and 16.1 % on the workshop recording (both
  between the lines). The baseline itself reads 11.3 %, 11.1 % and 18.9 %: on the workshop recording Discover with
  four visit workers moves footprints more than the line with no settle at all, and `CS2` moves them less than that
  (16.1 % against 18.9 %); on `14_57_02` it moves them more (13.6 % against 11.1 %). The split-half noise of the live
  library falls from 14-16 % to about 10 % with the settle.
- **R4, Discover not held back (a line added in this study, not one of the PI's three): missed as written.** `CS2` makes 10-14 % fewer ordinary visits than `V30` (line:
  5 %) and 1-9 % fewer adds (over the line on the workshop recording and `10_43_21`). It ends with 4.5 % fewer cells
  on the workshop recording (outside the +/- 3 % line), within the seed range on Samara. The frames-only arm `CS2F`
  has no settle jobs and shows the same shortfall (8-14 % fewer visits), and the visit workers are not busier in any
  `CS` arm than in `V30`. So settle jobs holding zones are not the cause. Not tested: whether the tiles simply come
  due less often once the library explains more of each frame (tiles come due through reservoir slots scored by
  the residual), or whether the busier slow worker hands visits out later. Minian (reference only, workshop): the
  live `CS2` libraries match 555-567 of its 708 units at median r 0.941-0.947, the live `V30` libraries 541-560 at
  0.937-0.941, so the missing cells are not Minian's.
- **Chosen arm by the rule: `CS2`** (mean share 77 %; `CS2-Q` 61 %). The quiet period brings nothing measurable:
  with visit workers the settle visits hardly ever change a footprint (next point), so there is nothing for it to
  hold back. `CS2-Q18` (one pair) reads like `CS2`.
- **The settle jobs do almost nothing.** Per run they accept 2-82 refinements (arm means) out of 5,800-22,500 settle jobs. With
  four workers the ordinary visits already come about four times as often as with one worker's budget (workshop:
  44,000 against 10,400 in round 1) and do the refining; what the settle adds is the re-read frames in the statistics. The
  frames-only arm closes as much of the gap (81 %, 70 %, 78 %). **So the design reduces to: re-read frames to the
  statistics, at two per live frame.** `CS1` (one per live frame, workshop, one pair): 64 %.

### R5. Total work against the end settle (no line)

Seed-to-seed r along the end pass, and the dose at which an arm reaches the baseline's settled value minus 0.002.
Work = slow-loop work units of Discover (slow worker and visit workers) plus the end pass up to that dose, against
`V30` with its full pass. Re-read frames are solved outside that count.

| recording  | arm    | after 1800 / 5400 / 9000 / 18000 end frames | end dose needed | Discover work | Discover + dose | re-read frames in all |
| ---------- | ------ | ------------------------------------------- | --------------- | ------------- | --------------- | --------------------- |
| workshop   | `V30`  | 0.9362 / 0.9539 / 0.9614 / 0.9733           | 18,000          | 1.00 x        | 1.00 x          | 18,000                |
|            | `CS2`  | 0.9614 / 0.9677 / 0.9717 / 0.9794           | 9,000           | 1.07 x        | 0.87 x          | 44,900                |
|            | `CS2F` | 0.9630 / 0.9676 / 0.9718 / 0.9784           | 9,000           | 1.06 x        | 0.85 x          | 44,900                |
| `10_43_21` | `V30`  | 0.9734 / 0.9828 / 0.9849 / 0.9891           | 18,000          | 1.00 x        | 1.00 x          | 18,000                |
|            | `CS2`  | 0.9839 / 0.9898 / 0.9905 / 0.9917           | 3,600           | 1.07 x        | 0.92 x          | 39,200                |
|            | `CS2F` | 0.9844 / 0.9872 / 0.9897 / 0.9913           | 5,400           | 1.00 x        | 0.83 x          | 41,000                |
| `14_57_02` | `V30`  | 0.9663 / 0.9787 / 0.9817 / 0.9863           | 12,600          | 1.00 x        | 0.82 x          | 12,600                |
|            | `CS2`  | 0.9791 / 0.9861 / 0.9885 / 0.9895           | 3,600           | 1.10 x        | 0.94 x          | 39,200                |
|            | `CS2F` | 0.9785 / 0.9831 / 0.9873 / 0.9911           | 9,000           | 1.03 x        | 0.84 x          | 44,600                |

- **About the same slow-loop work, two to three times the re-read frames.** To the same agreement, `CS2` costs
  0.87, 0.92 and 1.15 times the baseline's slow-loop work (the last against the baseline's 12,600-frame dose) and
  re-reads 39,000-45,000 frames against 12,600-18,000. It does not save work. It moves the work into the stream,
  where the look-back worker and the slow worker have the time.
- **The end pass shrinks to a half or a fifth** (9,000, 3,600 and 3,600 frames against 18,000, 18,000 and 12,600),
  and with a full pass the library ends above the baseline's (0.9794 against 0.9733, 0.9917 against 0.9891, 0.9895
  against 0.9863).
- The first 1800 frames of the end pass lower the baseline's agreement below its live value (0.936 against 0.947
  on the workshop recording) before it rises. Not looked into.

### S1. Sims do not regress: pass (quick tier, 5 sims; `cs2-q/ladder-vs-V30.md`, `ladder-vs-V30+S9600.md`, `checkpoints.md`)

Dropped frames: 0 in all 15 Discover runs. Slow worker 26-29 % busy without the settle, 36-42 % with it. Arm minus
`V30` (live, no end settle) [95 % CI]; the gap is `V30+S9600` minus `V30`:

| measure                          | `V30`        | gap                      | `CS2`                    | `CS2F`                   | `CS2` minus `V30+S9600`   |
| -------------------------------- | ------------ | ------------------------ | ------------------------ | ------------------------ | ------------------------- |
| footprint r, all cells           | 0.9905       | +0.0025 [0.0018, 0.0031] | +0.0031 [0.0024, 0.0038] | +0.0029 [0.0022, 0.0035] | +0.0006 [0.0001, 0.0012]  |
| footprint r, close pairs         | 0.9909       | +0.0024 [0.0016, 0.0034] | +0.0026 [0.0018, 0.0036] | +0.0022 [0.0013, 0.0032] | +0.0002 [-0.0004, 0.0009] |
| footprint r, born in second half | 0.9338       | +0.034 [0.005, 0.051]    | +0.025 [-0.007, 0.038]   | +0.034 [0.003, 0.048]    | -0.009 [-0.031, 0.005]    |
| bitten footprints, 0.75-1 D      | 0.292        | -0.114 [-0.164, -0.064]  | -0.082 [-0.132, -0.032]  | -0.084 [-0.137, -0.033]  | +0.032 [-0.014, 0.079]    |
| matched / false cells per sim    | 358.0 / 34.4 | +2.4 / -2.4              | +0.8 / -1.4 [-8.2, 5.4]  | -0.8 / -2.6 [-6.6, 1.4]  | -1.6 / +1.0               |

- Footprint r not lower (it is higher, CI excludes 0), false cells not higher, matched cells within 1 %: all lines
  met. The live `CS2` library is above the baseline's settled library on footprint r for all cells, and closes 72 %
  of the gap on bitten footprints (round 1 at 30 fps: 62 % and 46 %).
- With half an end pass (`CS2+S4800`) every row is inside the "equal to settled" lines of round 1 (born in second
  half -0.001, bitten share +0.003).
- Through the session the live library is better at every checkpoint (footprint r +0.0059 at one quarter, +0.0029
  at half, +0.0019 at the end, CIs exclude 0) and moves 2.9 % per 1200 frames at the end against 1.9 %.

### Verdicts

| target                                                         | verdict                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| T0 flags off = main                                            | pass                                                                                                                                     |
| R1 dropped frames                                              | met: 0 in 32 real runs and 15 sim runs                                                                                                   |
| R2 half of the gap, live library                               | met by `CS2`: 77 %, 78 %, 75 %                                                                                                           |
| R3 footprint movement                                          | not met as written: 10.6 % (met), 13.6 % and 16.1 % (between the lines); the baseline alone is at 18.9 % on the workshop recording       |
| R4 Discover not held back                                      | missed as written: 10-14 % fewer ordinary visits, 4.5 % fewer cells on the workshop recording; not caused by the settle jobs; cause open |
| chosen arm                                                     | `CS2`; the quiet period adds nothing; the frames-only arm added afterwards does as well                                                  |
| R5 total work                                                  | about the same slow-loop work, 2-3 times the re-read frames; the end pass shrinks to a half or a fifth                                   |
| S1 sims                                                        | pass                                                                                                                                     |
| by the pre-set rule (R1-R4 by one arm on all three recordings) | **no-go as it stands**: of the PI's three lines, drops and gap are met and movement is met on one recording of three; R4 missed          |

### Not done

- Design B (snapshot settle) was not prototyped: design A now meets the two numeric lines, and the context budget
  of this round was spent on the real-data runs. The plan is in `concurrent_settle2.md`.
- Why the `CS` arms make fewer ordinary visits and, on the workshop recording, end with fewer cells.
- A third Samara seed; 20 and 60 fps; fewer than four visit workers; shares other than one and two frames per live
  frame on Samara.
- `--job-ms`, `--units-per-ms` and `--lb-ms` were not re-measured in the browser. No app build, no browser run.
- The end settle as "the same unit" (it is still `--settle-frames`, the ordinary `observe`).
