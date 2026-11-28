# Repeatable Final settle: answers in request order, visits at fixed boundaries (28 Nov 2026)

Branch `feat/cala-repeatable-final-settle`. Code at 47e7993b for the speed, eval and off-vs-main
runs; acceptance and clip speed again at 0b380c33 (47e7993b merged with main #573–#577).
Headed Chrome, real GPU, `memory-measure.mjs --lookback`, default settle pool.
Evidence: `~/Projects/cala-data/runs/repeatable/p2b/` (NOTES.md, runs/, gt-eval.jsonl, eval-stats.txt).

## Why the Final settle differed between runs

- A look-back worker's trace solve warm-starts from the frame it solved last
  (`crates/cala/src/trace/solver.rs`). An answer therefore depends on the request that worker served
  before it.
- Answers were observed in arrival order, and the next request went to the worker whose answer began
  observation. So arrival order decided each worker's request history.
- Over 6 arms of saved runs, matched by request content and library: the answer traces were identical
  whenever the worker's previous request was the same (308/308). They differed in every case where it
  was not (40/40).
- Visit results were applied on arrival, which was a second, smaller source of difference.

## The change

- Answers are observed in request order, so each worker's sequence of requests is fixed.
- Visits go out between pieces of 4 settle frames. Their results are applied in hand-out order a fixed
  number of frames fed later (`settleVisitLag`: 8 frames with 4 visit workers at 0.4 visits/frame). The
  settle waits there for a late one (`ApplyBarrier`).
- A worker whose visit was applied is handed the next visit at once. Before, it was handed one only
  after the next piece, so each slot made one visit per 12 frames: 0.33 visits/frame against 0.4.
- This is active only when the run is repeatable and Discover kept its apply barrier to the end. At
  Max, for live streams and with `?debug&repeatable=0`, the Final settle is as before.

## Acceptance (s5/s6 clips, 60 fps, `--detlog --extract`)

| arm                  | commit   | runs | Extract digest sets | final library sets | detlog `--settle` pairs with a finding |
| -------------------- | -------- | ---- | ------------------- | ------------------ | -------------------------------------- |
| s5 default           | 47e7993b | 3    | 1                   | 1                  | 0/3                                    |
| s6 default           | 47e7993b | 3    | 1                   | 1                  | 0/3                                    |
| s5 `?debug&lbpool=0` | 47e7993b | 3    | 1                   | 1                  | 0/3                                    |
| s5 default           | 0b380c33 | 3    | 1                   | 1                  | 0/3                                    |
| s6 default           | 0b380c33 | 3    | 1                   | 1                  | 0/3                                    |
| s5 `?debug&lbpool=0` | 0b380c33 | 3    | 1                   | 1                  | 0/3                                    |

Extract digests cover ids, footprint starts/pixels/values, traces and signed traces.

## Speed: Final settle on vs off

| recording                       | commit   | ON settle (s) | OFF settle (s) | ON holds / waited          | cost  |
| ------------------------------- | -------- | ------------- | -------------- | -------------------------- | ----- |
| s5 clip, 1,000 frames, 60 fps   | 47e7993b | 3.6, 3.3, 3.4 | 3.9, 3.4, 3.3  | 36–43 / 65–67 ms           | −3 %  |
| s5 clip, 1,000 frames, 60 fps   | 0b380c33 | 3.4, 3.6, 3.6 | 3.4, 3.4, 3.4  | 43–45 / 71–76 ms           | +4 %  |
| workshop, first 10 AVIs, 30 fps | 47e7993b | 102.1, 103.9  | 62.3           | 958 / 37.3 s, 996 / 39.5 s | +65 % |

- On the clip the cost is within run-to-run noise (−3 % and +4 % on the two commits).
- On the 10,000-frame workshop clone, the settle takes about 1.65x as long. All of the extra time is spent waiting for
  visits: settle time minus the waits (about 65 s) equals OFF.
- With the fix the most visits owed fell from 8 to 3, and the visits paid at the end from 6 to 1. Before it, the whole
  workshop recording took 334 s, of which 153 s was waiting.
- The waits that remain are visits that are not back at their due point, 8 frames after they went out.
  - Those 8 frames take about 52 ms of feed. A settle visit is busy about 27 ms on average (OFF: 20 ms),
    so the tail is often late.
  - The lag cannot grow with 4 visit workers: a worker holds its visit until the visit is applied, and
    4 / 12 frames is under the rate.
  - Making it cheaper needs the worker freed when its result arrives, with more than one job queued per
    worker, keyed by hand-out order rather than by worker. That change is left for later.
- On this real recording, Discover itself already ended differently in the two ON runs (615 vs 628 cells,
  barrier held, no batch lost), so the final libraries differ too. That is a Discover gap, not one in the
  settle.
- The OFF baseline for the full workshop recording was lost: an edit reloaded the page mid-run. The
  10-AVI clone was used instead.

## Repeatable off matches main

Main (c8911feb) and the branch, both on s5 at 60 fps, were run with `&repeatable=0`, 2 runs each:

- The Discover-end ids (2fff5a) and final ids (9e0964) were the same in all 4 runs.
- The look-back counters were identical: need 1657 / 1081, Background settle 800 / 523 / 261 / 16.
- The settle was the same: 3.5–3.7 s, 0 holds, 400 visits, at most 3 owed.
- Final footprints differ from run to run in both, as OFF is not repeatable.
- In detlog-diff, main vs branch shows the same first differences as main vs main.

With repeatable on, the Discover detlog of main vs the branch is identical: F does not touch Discover.

## Quality vs ground truth, ON vs OFF (10 clips)

The decision rule was declared before any result was read, as for #567: d = ON − mean(OFF₁, OFF₂) per
clip, with a 95 % t-interval over the 10 clips (1,000-frame clips of sims-v3 motion/static s5–s9, 60 fps).
Scores come from `gtscore.py` against the oracle: Hungarian matching of detectable units at r ≥ 0.7.

| library      | n   | matched d (95 % CI) | unmatched d (95 % CI) | rule |
| ------------ | --- | ------------------- | --------------------- | ---- |
| Discover end | 10  | −4.2 [−11.1, +2.7]  | −0.1 [−2.6, +2.4]     | pass |
| final        | 10  | −1.3 [−8.9, +6.3]   | +0.6 [−1.4, +2.6]     | pass |

- The Discover-end scores of the ON runs equal #567's ON runs on every clip.
- The final matched count moved by −2 to +2 cells against #567 (0 on 7 of the 10 clips).
- The ON−OFF spread per clip (−20.5 on m9 to +11 on s6/s8) comes from Discover's schedule, as measured
  for #567.
