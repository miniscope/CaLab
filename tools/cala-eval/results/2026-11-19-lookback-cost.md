# Cheaper look-back, especially on motion recordings (19 Nov 2026)

Profile and targets written 19 Nov 2026 before any lever arm was measured (commit order shows it). Results go below
them.

## Question

COMBO (`--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --merge-guard-sep 0.6`)
meets every quality target against DR-main (Discover + 1 Refine) on the full tier, and costs less on static (-13 %)
and pairs (-24 %) sims, but not on motion (+2 % pass-loop wall,
[2026-11-19-no-refine-full-tier.md](2026-11-19-no-refine-full-tier.md)). Where does the motion look-back time go,
and can it be cut without losing quality?

## Profile (COMBO, one binary, motion_s5 and static_s5, 2 runs at once)

A profiling build of main 20cbfb99 with stage timers in `LookBack::frame` and the drain (wall, stdout only). Its
outputs (`footprints.bin`, `dump_trace.f32`, `final.tsv`) are byte-identical to `combo-full/COMBO` on both sims, so
the timers change nothing. Run tree `$CALA_DATA/demix-suite/lbcost-prof`.

Look-back frames are the same on both sims (23.6k, of which 4.7k in the drain; 15.7k pushed into the statistics).

| stage of a look-back frame                       | static_s5 (s) | motion_s5 (s) | motion - static |
| ------------------------------------------------ | ------------: | ------------: | --------------: |
| re-read raw (64-frame blocks, 376 reads)         |           1.0 |           1.0 |             0.0 |
| preprocess front (flat field, flicker, flatten)  |          34.6 |          35.3 |            +0.7 |
| motion warp + validity (stored records)          |           0.5 |          71.9 |           +71.4 |
| preprocess back (noise map, background floor)    |          12.5 |          22.9 |           +10.4 |
| trace solve, whole frame, current library        |          19.9 |          20.0 |            +0.1 |
| `observe_lookback` (render + statistics + store) |          11.8 |          13.8 |            +2.0 |
| drain visits (`SlowLoop::step` after Discover)   |          23.4 |          22.1 |            -1.3 |
| look-back wall in all                            |         104.9 |         188.4 |           +83.5 |

Deterministic counters from the same runs: 7908-7910 of the solved look-back frames are held out (a third: they are
solved, then `observe_lookback` drops them); 130-131 library loads into the look-back engine; and every recording
frame is re-preprocessed about 2.5 times (23.6k look-back frames over 9.6k frames).

**Plainly.** The look-back's cost is mostly _getting the frame_, not using it. Re-reading, preprocessing and
registering a past frame is 49 s of 105 s on static and 131 s of 188 s on motion. **Motion differs from static by
the warp** (the bicubic field warp of each re-read frame by its stored record, plus the validity mask: about 3 ms
per frame) **and the masked background stage** (+10 s). Everything after the frame is in hand (solve, statistics,
drain visits) costs the same on both. The live Discover pass on motion already did that preprocessing and warping
once for every frame; the look-back redoes it about 2.5 times per frame.

Why the Refine pass hurts less: DR-main's Refine pass on motion also re-warps, but 9600 frames, against the
look-back's 23.6k. Per frame the motion surcharge is the same (~4.3-4.8 ms).

Instructions retired (`time -l`, nearly load-independent) from the full-tier runs: motion 12.77-12.91 T (DR-main) vs
13.59-13.79 T (COMBO), static 6.59-6.74 T vs 5.74-5.92 T. Slow-loop work units are already lower for COMBO in total
(one pass of ~48 M/frame against DR-main's two of ~36-37 M), so the slow loop is not the motion problem.

What this rules out: a patch-only trace solve can save at most the 20 s of solve (about 11 % of the motion look-back)
and needs a sub-library per block; skipping the solve of held-out frames saves about a third of it (~7 s). The large
lever is to stop re-making the frame.

## Levers (flags of `qc_eval`, off by default, byte-identical when off)

1. `--lookback-cache W`: the live loop's last `W` preprocessed, registered frames (exactly the `y` the live trace
   engine and slow loop got) are kept in a ring as half floats. A look-back frame found there is not re-read,
   preprocessed or warped. Births need the `K = 3000` frames before them, so `W` near `K` should serve most of the
   look-back from memory. A flat-field update with a 99th-percentile change above 0.5 sigma (in practice the first
   map) drops the ring, since cached frames carry the old flat field. Cost: 0.72 MB per frame at 600 x 600 (W = 3072:
   ~2.2 GB). The cached frame was preprocessed with the preprocessor state of its own time, not today's; that is the
   one quality risk.
2. `--lookback-skip-heldout`: held-out frames are not solved (they never enter the statistics). Each still costs its
   budget, so which frames are served does not change.

## Targets

Arms, one binary, same concurrency: `DR-main` (suite default), `COMBO`, `COMBO-c` (COMBO + `--lookback-cache 3072`),
`COMBO-cs` (COMBO-c + `--lookback-skip-heldout`). Sims: quick tier (static s5-s7, pairs s5-s6) plus motion s5-s7.

Quality (candidate vs `COMBO`, paired suite rules, 95 % CI):

1. Footprint r median, all / isolated / close-pair: within 0.002 of `COMBO` (diff >= -0.002, or CI includes 0).
2. Share r < 0.9, all / isolated: within noise of `COMBO`.
3. Crosstalk headline (corr excess < 1 D) and bite shares: within noise of `COMBO` or better.
4. Matched cells within 1 % of `COMBO`; false cells within noise.
5. Footprint r by birth time (second half, last 20 %): within noise of `COMBO`.
6. Against `DR-main`: the #430 targets still met (reported for the 8 sims).

Cost:

7. Motion: summed pass-loop wall of motion s5-s7 below `DR-main`'s in the same run, and instructions retired below
   `DR-main` on every motion sim.
8. Deterministic: frames re-preprocessed by the look-back cut by at least half; instructions retired below `COMBO`
   on every sim.
9. Peak RSS at most 4 GB per run (cap 6 GB).
10. Flags off: byte-identical to main (COMBO flags vs `combo-full/COMBO`, default flags vs `combo-full/DR-main`).

Not expected to move: slow-loop work units per frame (the cache changes what feeds the statistics, not the visits).

## Results (19 Nov 2026; 8 sims: static s5-s7, pairs s5-s6, motion s5-s7)

One binary for all arms (`qc_eval-lbcost-b`, this branch's levers before the rebase onto #431, #432 and #433).
Run conditions: arms of a sim ran together (paired), 6 runs at once for motion s5-s6 and 4 after that (another
agent needed two slots), the machine was swapping (swap nearly full, much memory compressed), and clippy and the
tests ran during the static and pairs runs. So wall seconds are noisy; instructions retired is the anchor. Run tree `$CALA_DATA/demix-suite/lbcost` (reports `report-COMBO-vs-COMBO-cs.md`, `report-COMBO-vs-COMBO-c.md`,
`report-DR-main-vs-COMBO-cs.md`, `report-DR-main-vs-COMBO.md`; their header names the default binary because they
were rendered with `--report-only`). The PR's code is the same levers ported onto #431's crate scheduler; its build
reproduces `COMBO-cs` on static_s5 and `COMBO` and `DR-main` with the new flags off byte for byte (below).

### In plain language

Keeping the live loop's recent frames in memory, so the look-back does not re-read, re-preprocess and re-warp them,
makes the look-back cheaper everywhere and fixes motion. On motion sims COMBO now uses 15 % less pass-loop wall than
Discover + Refine (it used 2 % more) and 10 % fewer instructions; over all 8 sims the saving against Discover + Refine
grows from 8 % to 23 % of wall. Skipping held-out look-back frames adds a little more. Quality is unchanged against
COMBO: all 67 suite metrics within noise; the late-born rows lean slightly worse but the sample is small. The price is
memory: about 2.3-2.5 GB more per run (peak memory footprint 3.2-4.05 GB on 600 x 600 sims with a 3072-frame
cache, against 0.9-1.6 GB), which misses the 4 GB target by 0.05 GB on motion_s7.

**The one quality caveat: cells born late.** Both cache arms lean worse on cells born in the second half
(footprint r -0.0068 [-0.0160, +0.0035], share r < 0.9 +0.058 [-0.019, +0.138] vs COMBO), and against DR-main the
share r < 0.9 of those cells now flags worse (+0.091 [0.018, 0.165]; COMBO alone: within noise). Within the targets,
but on ~230 cells; the follow-up is COMBO vs COMBO-cs on the other six full-tier sims to double that sample.

Recommended: `--lookback-cache 3072 --lookback-skip-heldout` (`COMBO-cs`).

### Cost

Pass-loop wall summed over the sims (s), instructions retired (T, `time -l`), largest "maximum resident set size"
(GB; under-counts compressed pages, see the footprint line below) and look-back wall (s):

| group      | DR-main                | COMBO                    | COMBO-c (cache)          | COMBO-cs (cache + skip)  |
| ---------- | ---------------------- | ------------------------ | ------------------------ | ------------------------ |
| motion (3) | 1536 / 38.41 / 1.3 / 0 | 1568 / 41.13 / 1.7 / 661 | 1320 / 34.83 / 3.4 / 400 | 1298 / 34.43 / 3.5 / 376 |
| static (3) | 1035 / 19.97 / 1.0 / 0 | 895 / 17.48 / 1.1 / 346  | 787 / 15.89 / 3.4 / 224  | 772 / 15.56 / 3.4 / 210  |
| pairs (2)  | 476 / 9.27 / 0.8 / 0   | 351 / 7.12 / 0.9 / 109   | 298 / 6.26 / 3.2 / 47    | 288 / 6.04 / 3.2 / 37    |
| all 8      | 3047 / 67.65           | 2814 / 65.73 (-8 %)      | 2405 / 56.98 (-21 %)     | 2358 / 56.03 (-23 %)     |

Peak memory footprint (`time -l`, counts compressed pages; the right measure here), largest per group: DR-main
1.58 / 1.05 / 0.85 GB (motion / static / pairs), COMBO 1.58 / 1.15 / 0.95, COMBO-c 4.04 / 3.50 / 3.21, COMBO-cs
4.05 / 3.50 / 3.22.

Per motion sim, wall and instructions of `COMBO-cs` vs `DR-main`: s5 428 vs 505 s, 11.47 vs 12.77 T; s6 437 vs 519 s,
11.45 vs 12.85 T; s7 432 vs 512 s, 11.51 vs 12.79 T. Instructions are below `COMBO` on every one of the 8 sims.

Where the motion look-back time went (motion_s5, s): COMBO read 1.7, front 40.5, warp 79.4, back 27.1, solve 21.5,
observe 16.2, drain visits 24.3 (213 in all); `COMBO-cs` read 0.5, front 15.7, warp 30.2, back 10.3, solve 15.3,
observe 16.7, drain visits 28.6 (124).

Deterministic counters (per sim): look-back frames re-made (re-read, preprocessed, registered) fall from ~23.6k to
5.4-5.8k on static (-76 %), 2.7-3.8k on pairs, and 8.7-9.1k on motion (-62 %). The misses are the frames older than
the cache (age > 3072, ~5.5k per sim; births are served with a lag, so ages reach past `K`) plus, on motion, the
~3k frames dropped when the first flat-field map arrives at frame 2999 (one clear per motion sim; later maps change
by <= 0.06 sigma and keep the cache). The half-float rounding is at most 0.016 noise sigma. Held-out skip: 7.9-8.4k
solves saved per static/motion sim (solve 21.5 -> 15.3 s on motion_s5). Slow-loop work units per frame unchanged
(46.0 M vs 46.3 M, within noise). With the skip on, `lookback.tsv`'s `frames` and `cell_frames` count solved frames
only, so they fall by about a third without less being served; the skipped count is on stdout (`frames passed
over`).

### Quality, `COMBO-cs` vs `COMBO` (targets 1-5; paired suite rules)

All 67 metrics within noise except peak RSS (worse, +1.8 GB). Headline +0.087 -> +0.091 (+0.004 [-0.010, +0.019]).

| metric                                        | COMBO                 | COMBO-cs              | diff [95 % CI]                                  |
| --------------------------------------------- | --------------------- | --------------------- | ----------------------------------------------- |
| Footprint r median, all                       | 0.9900                | 0.9898                | -0.0002 [-0.0009, 0.0004]                       |
| Footprint r median, isolated                  | 0.9902                | 0.9898                | -0.0004 [-0.0021, 0.0016]                       |
| Footprint r median, close-pair                | 0.9898                | 0.9895                | -0.0003 [-0.0013, 0.0006]                       |
| Share r < 0.9, all / isolated                 | 0.053 / 0.027         | 0.058 / 0.035         | +0.005 [-0.006, 0.015] / +0.008 [-0.023, 0.039] |
| Trace corr excess < 1 D (headline)            | +0.087                | +0.091                | +0.004 [-0.010, +0.019]                         |
| Bite share < 0.5, 0-0.5 / 0.5-0.75 / 0.75-1 D | 0.181 / 0.163 / 0.276 | 0.204 / 0.165 / 0.288 | all CIs include 0                               |
| Matched cells (mean per sim)                  | 411.4                 | 409.2                 | -2.1 [-6.0, 1.8] (-0.5 %)                       |
| False cells                                   | 20.2                  | 23.0                  | +2.8 [-0.6, 6.1]                                |
| Footprint r median, born second half          | 0.9545                | 0.9478                | -0.0068 [-0.0160, 0.0035]                       |
| Share r < 0.9, born second half               | 0.228                 | 0.286                 | +0.058 [-0.019, 0.138]                          |
| Footprint r median, born last 20 %            | 0.9217                | 0.9172                | -0.0045 [-0.0414, 0.0294]                       |

`COMBO-c` (cache only) vs `COMBO`: the same picture (all within noise except RSS; second half -0.0058 [-0.0163,
0.0035], last 20 % -0.0190 [-0.0494, 0.0175]). The late-born rows lean worse in both cache arms, but per sim the
sign is mixed (static_s5 and motion_s7 second-half medians go up, static_s6 and static_s7 down) and they rest on
~230 cells, so this is "not shown different", not "shown equal". A cached frame was preprocessed with the background
floor and noise map of its own time rather than today's; that is the one mechanism that could matter for cells born
late, and a larger late-born sample would be needed to see it.

### Against `DR-main` (target 6: the #430 targets, 8 sims)

`COMBO-cs` vs `DR-main`: footprint r all +0.0016 [0.0009, 0.0023], isolated -0.0024 [-0.0040, -0.0009] (inside the
0.003 allowance, as for COMBO's -0.0020), close-pair +0.0049; share r < 0.9 all / isolated within noise; headline
+0.149 -> +0.091 (better), bite shares better in every bin; matched -3.0 [-6.9, 0.9] (-0.7 %), false within noise.
All met. One flag new against COMBO: share r < 0.9 among cells born in the second half, +0.091 [0.018, 0.165]
(COMBO: +0.032 [-0.034, 0.101]); not a #430 target, same caveat as above.

### Targets, judged

| #   | target                                      | result                                                                   |
| --- | ------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | footprint r within 0.002 of COMBO           | met (-0.0002 / -0.0004 / -0.0003)                                        |
| 2   | share r < 0.9 within noise                  | met                                                                      |
| 3   | crosstalk and bites within noise            | met                                                                      |
| 4   | matched within 1 %, false within noise      | met (-0.5 %; false +2.8, CI includes 0)                                  |
| 5   | late-born rows within noise                 | met, leaning worse (see above)                                           |
| 6   | #430 targets vs DR-main                     | met                                                                      |
| 7   | motion wall and instructions below DR-main  | met: wall -15 % (1298 vs 1536 s), instructions lower on every motion sim |
| 8   | re-made frames halved, instructions < COMBO | met: -62 % (motion) to -76 % (static); instructions lower on all 8 sims  |
| 9   | peak RSS <= 4 GB                            | missed by 0.05 GB: peak footprint 4.05 GB (motion_s7), 3.9 on s5/s6      |
| 10  | flags off byte-identical                    | met (below)                                                              |

### Other checks

- **Byte identity.** The PR build (rebased onto #431) with no new flags: `footprints.bin`, `dump_trace.f32` and
  `final.tsv` identical to `combo-full/COMBO` (static_s5, COMBO flags) and `combo-full/DR-main` (pairs_s5, default
  flags). With `--lookback-cache 3072 --lookback-skip-heldout` it reproduces this run's `COMBO-cs` static_s5 byte for
  byte, so the measured numbers stand for the PR code.
- **Tried and dropped.** Marking due only the tiles of cells the drain fed (instead of every tile every 64 drain
  steps) saved nothing on motion_s5 as implemented (drain visits 28.6 s either way; the final mark-all and 256 steps were
  kept). A 2048-frame cache (motion_s5 only) gave 444 s / 11.87 T against 428 s / 11.47 T for 3072, with a 2.96 GB
  instead of 3.90 GB peak footprint (hit rate 51 % against 62 %).
- **Not done.** A patch-only trace solve: with the frames cached, the solve is 15 s of the 124 s motion look-back, so
  it is the next lever only after the drain visits (25-34 s) and the remaining misses.

### For the app

The ring is `calab_cala::discover::FrameCache` (half floats, `push` / `get` / `clear`). In the browser 3072 frames of
600 x 600 are 2.2 GB, too much for a tab. The hit rate is ~62 % (motion) / ~76 % (static) at 3072 frames and
51 % at 2048 (motion_s5), so the app should size the ring to the memory it has. The cache reads the live loop's output only; the fast loop is unchanged (QC ms/frame within noise).
