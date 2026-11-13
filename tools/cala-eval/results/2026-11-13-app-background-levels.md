# App slow loop without the ring-background levels (13 Nov 2026)

Question: the app's slow worker observed every frame with the traces only.
`SlowLoop.observe` (JS) cleared `FrameTraces::background`, so under the default
ring background (`Ring { inner_px: 12, outer_px: 20 }`) the ledger coordinate
and the running footprint statistics kept each cell's local background level.
`qc_eval` passes the trace engine's whole `FrameTraces`. How far apart are the
two slow loops?

**Answer: the effect is small, within run-to-run noise on every metric.** The
fix (the levels now travel with the traces, in Discover and in Refine) makes the
app run the slow loop `qc_eval` evaluates. It does not change the quality
numbers.

## Method

`qc_eval --no-bg-levels` (diagnostics) clears `background` before each frame
goes to the slow loop, exactly as the app did. Same binary (branch
`fix/app-bg-levels`, based on 13f57aa), paired runs, slow seed 1.

- Sims: `sims-gt110` `static_s5`, `static_s6` and `static_s7`, `--batch 8
--slow-seed 1 --churn-log --budget 30000000`. The static arms only, because
  the motion arm's scoring has a GT-offset bug being fixed separately.
- Real: workshop prerecorded session, `--motion --frames 18000 --batch 8
--budget 30000000 --via-jobs --churn-log --slow-seed 1 --support-rule
basin-skirt`. The control reproduces the S2.1d `gate_s1` run exactly (733
  cells, S8 22 156).

`with levels` is `qc_eval` as it is (and the fixed app). `without` is the old
app path.

## Sims (static, 3 seeds, d = without − with, mean ± 95 % t-CI)

| Metric                          | with levels   | without       | d            |
| ------------------------------- | ------------- | ------------- | ------------ |
| P8                              | .947          | .946          | −.002 ± .006 |
| R8                              | .785          | .780          | −.005 ± .018 |
| R2                              | .589          | .580          | −.009 ± .013 |
| P2                              | .942          | .932          | −.010 ± .014 |
| `r_fp`                          | .969          | .969          | −.001 ± .005 |
| `fp_dup`                        | 1.3           | 2.7           | +1.3 ± 2.9   |
| cells                           | 511.0         | 508.7         | −2.3 ± 11.2  |
| late `conv_big4`                | .113          | .122          | +.009 ± .006 |
| median support, px (pos / disk) | 506 / 759     | 499 / 750     |              |
| refines (s5, s6, s7)            | 409, 402, 444 | 408, 407, 439 |              |

The precision and recall differences all point the same way (the levels help
slightly), but every CI covers 0. Only `conv_big4` is consistently higher
without the levels (3 of 3 seeds): footprints move a little more late in the
run.

## Real (seed 1)

| Metric                     | with levels    | without       |
| -------------------------- | -------------- | ------------- |
| cells                      | 733            | 731           |
| texture                    | 1              | 0             |
| S8                         | 22 156         | 22 316        |
| AUC_S                      | 15 896         | 16 609        |
| Minian agreement ≥ .5      | 521            | 530           |
| Minian agreement ≥ .7      | 406            | 418           |
| median footprint, px       | 452            | 462           |
| median half-max radius, px | 4.89           | 4.98          |
| adds / merges / deletes    | 955 / 260 / 10 | 971 / 280 / 3 |
| refines                    | 545            | 505           |

On real data the old app path is slightly _better_ on the ground-truth-free
scores and on Minian agreement (+9 cells at ≥ .5). The seed-to-seed spread of
the same binary is of that size (the S2.1d controls, slow seeds 1 and 2: 731 vs
762 cells, Minian 531 vs 534; the gate runs 521 vs 522). One seed cannot tell
the two apart.

## Notes

- The visit jobs never see the levels directly. A job works on the
  reservoir's whitened residual (no ring term) and on the footprint statistics,
  which were built in `observe`, so the fix reaches them through those
  statistics.
- On the toy movie of the stage tests, the levels remove the refines the
  Refine replay used to make in 1500 frames; it needs 2400. With the levels,
  some refines driven by the local background go away.
