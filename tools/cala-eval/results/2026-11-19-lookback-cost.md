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
