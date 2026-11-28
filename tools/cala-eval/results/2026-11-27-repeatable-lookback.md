# Repeatable Discover: look-back at every batch end, and ON vs OFF on ten clips (27 Nov 2026)

Branch `feat/cala-repeatable-barrier` (PR #567), code at c7affc22 (head b4bd0c47 adds docs only).
Headed Chrome, real GPU, `memory-measure.mjs --lookback --pacefps 60`, default settle pool.
Clips: the first 1,000 frames (`0.avi`) of sims-v3 `v3_motion_s5..s9` and `v3_static_s5..s9`.
Evidence: `~/Projects/cala-data/runs/repeatable/p2a2/` (NOTES.md, runs/, gt-eval.jsonl, eval-stats.txt).

## Look-back throughput under the apply barrier

Before this change each look-back worker had one request out at a time, and the next one went out at
the barrier, so Discover re-read about half the frames. Now every look-back worker gets one request at
every batch end (two out at once, at a lag of two batches). Answers are applied at b + 2 in request
order. Each request names the library version it is solved with.

| s5 clip, 60 fps                  | need requested / pushed | Background settle requested / fit / held / dropped | barrier waits |
| -------------------------------- | ----------------------- | -------------------------------------------------- | ------------- |
| OFF (`&repeatable=0`)            | 1657 / 1081–1093        | 800 / 523 / 261 / 16                               | –             |
| ON, one request per two batches  | 864 / 551               | 800 / 410 / … / 192                                | 1             |
| ON, one request per batch (this) | 1656 / 1070             | 800 / 523 / 261 / 16                               | 0             |

- Over the ten eval clips, the ON runs requested 1656 need frames on every clip (OFF: 1657), and the
  Background settle numbers matched OFF.
- Barrier waits were 0–1 per run (at most 50 ms). No batch was dropped.
- Determinism: in detlog-diff over Discover, 0 of 8 ON pairs had any finding (s5 ×4 runs, s6 ×2,
  lbpool 0 ×2). Each arm reached Discover's end with one footprint set. The final footprints still
  differ between runs: the Final settle is not repeatable yet (fix F).
- `?debug&lbpool=0` (worker 0 serves both need-driven look-back and the settle) is still short of OFF:
  need 1032 vs 1497 and settle fit 410 vs 501, with 0 waits.
  - Two requests per batch end on worker 0 brought the frames back, but the worker could not keep up.
    That caused 12–27 waits (0.9–2.4 s) and one dropped batch, which ends the run's repeatability. That
    variant was not kept.

## Quality vs ground truth, ON vs OFF

The decision rule was declared before any result was read. For each clip, d = ON − mean(OFF₁, OFF₂),
with a 95 % t-interval over the 10 clips. ON is acceptable as the default if the matched CI covers 0
or lies above it, and unmatched does not rise beyond noise (CI above 0 and mean above the within-clip
SD of OFF).

Scores come from `gtscore.py` against the sim's oracle: Hungarian matching of detectable units at
r ≥ 0.7.

| library      | n   | matched d (95 % CI) | unmatched d (95 % CI) | rule |
| ------------ | --- | ------------------- | --------------------- | ---- |
| Discover end | 10  | −4.1 [−10.8, +2.6]  | −0.1 [−2.6, +2.4]     | pass |
| final        | 10  | −1.3 [−8.6, +6.0]   | +0.6 [−1.5, +2.7]     | pass |

Per clip, the final matched d was:

| m5    | m6   | m7   | m8    | m9    | s5   | s6   | s7   | s8    | s9   |
| ----- | ---- | ---- | ----- | ----- | ---- | ---- | ---- | ----- | ---- |
| +11.0 | +1.0 | −5.5 | −13.0 | −20.5 | +1.0 | +9.0 | −0.5 | +10.0 | −5.5 |

The two OFF runs of a clip differ by about 1 matched cell (SD 0.9), but ON vs OFF moves a clip by up
to 20. Changing the order in which results are applied acts like a different seed, not like run-to-run
noise. The effect on the mean is within ±9 cells of 0 at both stages.
