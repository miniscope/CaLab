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

| app                                                                                                                      | model                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visit workers: cores minus 5 reserved threads, at most 4 (`visitWorkerCount`): 4 on a machine with 9 or more cores       | `--visit-workers 4`. A machine with fewer cores has fewer; with 5 or fewer the slow worker visits itself (round 1's model).                                                            |
| The slow worker observes each batch and hands a visit to every idle worker after each batch and each result (`dispatch`) | the same order: one message at a time, hand-out after each; one visit out per worker (`--visit-depth 1`, the app's `busy` flag)                                                        |
| A visit costs the worker its compute; the slow worker pays encode, copy and decode per job                               | work units at `--units-per-ms 2e6` (the harness's WASM calibration) on the worker, plus `--job-ms 1` on each side (the harness default; not re-measured with cluster stores in a job) |
| Forward buffers: 4 with visit workers (`PARALLEL_FORWARD_BUFFERS`); a batch with no free buffer is dropped               | `--pool 4`; `--batch 8`                                                                                                                                                                |
| `housekeep` (trimming, publishing) on the slow worker after each message                                                 | the same call, charged its work units                                                                                                                                                  |
| Look-back worker: one request out at a time, at most 16 frames, re-reads, preprocesses and solves                        | settle requests: one out at a time, 16 frames, answered `--lb-ms` per frame after the worker's earlier work; the answer is one slow-worker message that costs all its fitting frames   |
| Look-back worker speed: about 200 frames per second during Discover on the workshop recording (look-back review)         | `--lb-ms 5` (round 1 used 10)                                                                                                                                                          |
| Need-driven look-back (2 frames per live frame at most) shares the look-back worker                                      | applied at the live frame as in round 1 (not delayed), slow worker charged its statistics work; the look-back worker's time is booked for it, ahead of settle requests                 |
| A look-back answer was solved with the library the look-back worker had when it started                                  | solved with the library at the moment the answer is handled (up to 80 ms newer)                                                                                                        |
| Settle visits: not in the app                                                                                            | after `take_job` returns nothing for a worker, `take_settle_job`                                                                                                                       |

Not in the model: contention with the fast pipeline's workers and the main thread, garbage collection, message
latency, memory. The end settle after the stream is not timed (it runs after the last frame in both arms).

## Arms

Real recordings, stream at 30 fps. Common flags (`D`): `--motion --batch 8 --budget 30000000 --slow-seed N --passes 1
--joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6 --offered-fps 30 --visit-workers 4 --pool 4
--lb-ms 5 --lib-at 0.125,..,0.875`, then one end settle pass with libraries (`--settle-frames 18000 --settle-batch 16
--settle-libs --settle-check 1800`). Workshop: `--frames 18000`, slow seeds 1-3. Samara `10_43_21` and `14_57_02`:
`--fps 30`, slow seeds 1-2.

| arm        | added to `D`                                                  | what it is                                              |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `V30`      | `--csettle 0`                                                 | baseline: the app's Discover with 4 visit workers       |
| `CS1`      | `--csettle 0.5 --csettle-mode stats`                          | 1 re-read frame per live frame, settle visits as jobs   |
| `CS2`      | `--csettle 0.667 --csettle-mode stats`                        | 2 per live frame                                        |
| `CS2-Q`    | `--csettle 0.667 --csettle-mode stats --csettle-quiet 600`    | the same, only on tiles stable for 600 frames (20 s)    |
| `CS2-Q18`  | the same with `--csettle-quiet 1800`                          | slow seed 1 only (sensitivity; not eligible as "chosen") |

"Live" = the library at the end of the stream (`settle0`). "Settled" = the same run after the end pass (`final`).

## Targets

"Gap" on a recording = seed-to-seed median footprint r of `V30` settled minus `V30` live (`lookback_settled.py`,
Hungarian match at r >= 0.7, as round 1), mean over the seed pairs. An arm's share of the gap = (its live seed-to-seed
r minus `V30`'s live) / gap.

**T0. Flags off = main** (binary `qc_eval-main-f184a49d`), static_s5, every output file, wall-time fields masked:
`SETTLE` lock-step; `--offered-fps 30 --visit-workers 4` (no `--csettle`); round 1's `--offered-fps 30 --csettle
0.75 --csettle-mode stats` (no visit workers). And on this branch: `CS2` branched after Discover equals unbranched.

**R1. Dropped frames: 0 in every real run**, `V30` and `CS` (7 runs per arm). Any dropped frame in a `CS` run is a
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

**Chosen arm.** Among `CS1`, `CS2`, `CS2-Q` with R1 met: the highest mean share of the gap over the three
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

## Results

(to be filled)
