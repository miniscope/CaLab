# S2.1 step 1: the measured support rule (Rings vs Basin vs BasinSkirt)

12 Nov 2026. Binary `s21-c3978cd`, built from PR #344 with `--features diagnostics`. One binary, three arms:

- `ctl`: `--support-rule rings` (the default, which is byte-identical to main);
- `basin`: `--support-rule basin`;
- `skirt`: `--support-rule basin-skirt`.

`--support-alpha` is 0.05 in every arm. Paths below are the scratch directory `scratchpad/s21support`, which is not in the repo.

## Verdict

**Do not flip the default yet.** (Superseded: the divergence was fixed in `2026-11-12-skirt-stability.md`, and
`BasinSkirt` became the default after the PI accepted that note's gate redefinitions.) `BasinSkirt` delivers the boundedness that was the point of the change: no runaway footprints, and no texture on real data across passes. It also keeps recall and precision within margins at 1×. But two primary gates fail, and one of the failures is a new defect:

- **The fast loop diverges in 2 of 10 refine-only `skirt` runs.** In `motion_s8` and `static_s7` the explained variance goes to `-inf` and traces reach about 1e20 in pass 2. `basin` (0/10), R1, R2, R3, R5, R6 and R7 never diverged. The cause is specific to the skirt: the skirt columns put positive block light into the neighbours' ring background. The likely mechanism is the ring model's coupled coordinate updates becoming unstable (compare `ring_self_curvature`, which already guards the self term). This is a hypothesis; it was not traced.
- **Median support still creeps.** On sims, pass 3 over pass 1 is 1.15 against a gate of ≤ 1.10, and `basin` gives the same. On real data refine-only gives 1.63. p99 is flat everywhere, so the large cells are bounded and it is the small cells that grow toward their limit. The falsifier did not fire: 2 of 10 runs rise more than 5 % from pass 2 to pass 3 (the falsifier needs 5).

Next steps:

1. Fix the divergence by making the ring level and the skirt consistent: exclude skirt blocks from the ring's level estimate, or treat the skirt as part of the cell's own ring column. Then rerun R4.
2. Decide with the PI whether a slowly converging median (the threshold falls as `n^-1/2` against a soft lobe edge) is acceptable. Test 6 in the PR shows the same behaviour on a planted halo.

## Identity

`ctl` matches main be6bff3 byte for byte on `$SIM_MOTION_S5` (9600 frames, `--batch 8 --budget 30000000 --slow-seed 1 --churn-log`). The identical files are `final`, `cells`, `adds`, `removals`, `global`, `footprints.bin`, `convergence`, `edits`, `tests`, `heldout`, `fp_history`, `gt` and `traces_gt`. The same holds for a 2400-frame `--via-jobs` run. Only the wall-time columns differ.

R1 `ctl` `motion_s5` (with `--motion`) also equals the S2.3 pass-1 run. The S2.3 and S2.3b sims runs are therefore valid `ctl` baselines for R3 and R4 (all 10 seeds).

For R6 and R7 on real data, `ctl` is taken from S2.3 (`s23/real`) and S2.3b (`s23b/real/refine_s*`). The R5 `ctl` seed-2 run reproduces those S8 and texture numbers exactly. The R5 `ctl` seed-1 run does not reproduce the S2.3 pass-1 run (681 cells against 662). That run used `--via-jobs`, whose scheduling may differ, so treat the real-data `ctl` with that caveat.

## Runs

| Id  | Data                                                        | Arms              | Notes                          |
| --- | ----------------------------------------------------------- | ----------------- | ------------------------------ |
| R1  | sims, 1×, motion and static seeds 5–9                       | ctl, basin, skirt | 30 runs                        |
| R2  | sims, 4×, motion seeds 5–9                                  | ctl, skirt        | 10 runs                        |
| R3  | sims, 3 passes, all edits                                   | skirt             | ctl from S2.3                  |
| R4  | sims, 3 passes, refine-only                                 | basin, skirt      | ctl from S2.3b                 |
| R5  | real, 18000 frames, `--via-jobs --churn-log`, seeds 1 and 2 | ctl, basin, skirt | `CALA_SUPPORT_AUDIT` on seed 1 |
| R6  | real, 3 passes, all edits, seeds 1 and 2                    | skirt             | ctl from S2.3                  |
| R7  | real, 3 passes, refine-only, seeds 1 and 2                  | skirt             | ctl from S2.3b                 |

Support size is the count of positive pixels from `support_sizes.py`, the mean over runs of the per-run statistic.

## Primary gate: refine-only passes stay bounded (R4, R7)

| Quantity                                             | ctl            | basin | skirt               | Pass if | basin | skirt    |
| ---------------------------------------------------- | -------------- | ----- | ------------------- | ------- | ----- | -------- |
| Sims runs with a footprint > 50 000 px               | 7/7 (S2.3b)    | 0/10  | 0/10                | 0       | PASS  | PASS     |
| Sims runs with explained variance < .85 after pass 1 | 5/7            | 0/10  | **2/10** (diverged) | 0       | PASS  | **FAIL** |
| Sims median support, pass 3 / pass 1                 | 1.55           | 1.15  | 1.15                | ≤ 1.10  | FAIL  | FAIL     |
| Sims p99 support, pass 3 / pass 1                    | 8.72           | 0.96  | 0.94                | ≤ 1.25  | PASS  | PASS     |
| Real p99 support, pass 3 / pass 1                    | 11.8 (2 seeds) | —     | 1.06 (2 seeds)      | ≤ 1.25  | —     | PASS     |
| Real texture count at pass 3                         | 32, 27         | —     | 0, 1                | ≤ 9     | —     | PASS     |

- **Falsifier.** No run had a footprint above 50k px. The median rose more than 5 % from pass 2 to pass 3 in 2 of 10 `skirt` runs. The falsifier did not fire.
- **Largest footprint at pass 3.** Sims: 1468 px for `skirt`, 1680 px for `basin`, about 320 000 px for `ctl`. Real (R7): 1572 px for `skirt`, 207 000 px for `ctl`.
- **Real refine-only, per pass, `skirt` seeds 1 and 2:**
  - S8: 54 570, 82 960, 88 809 (seed 1) and 49 460, 81 970, 84 751 (seed 2);
  - Minian agreement at ≥ .5: 537, 564, 569 and 534, 562, 567;
  - seed-to-seed Jaccard: .680 at pass 1, .747 at pass 3.

  Under `ctl`, refine-only drove texture to 32 and the footprints to the whole field of view.

## Secondary gates (`skirt` vs `ctl`, paired by seed; mean d ± 95 % CI, n = 5 per sim arm)

| #   | Metric                                       | ctl                                        | skirt                                              | Pass if              | Result                             |
| --- | -------------------------------------------- | ------------------------------------------ | -------------------------------------------------- | -------------------- | ---------------------------------- |
| 1   | Real p99, all edits, pass 3 / pass 1 (R6)    | 1.58 (S2.3)                                | 1.25                                               | ≤ 1.25               | PASS (at the limit)                |
| 2   | Sims p99, all edits (R3)                     | 1.52                                       | 1.13                                               | ≤ 1.25               | PASS                               |
| 2   | Real median, all edits (R6)                  | 1.30                                       | 1.29                                               | ≤ 1.15               | **FAIL**                           |
| 3   | P8, 1× (motion / static)                     | .930 / .953                                | d −.011 ± .016 / −.007 ± .022                      | ≥ −.02               | PASS                               |
| 3   | R8, 1×                                       | .751 / .781                                | d +.018 ± .011 / +.014 ± .018                      | ≥ −.02               | PASS                               |
| 4   | R2, 1×                                       | .535 / .582                                | d +.024 ± .028 / +.017 ± .012                      | ≥ −.05               | PASS                               |
| 5   | `r_fp`                                       | .945 / .973                                | d −.002 ± .004 / −.001 ± .004                      | ≥ −.010              | PASS (`basin`: −.010 / −.011)      |
| 6   | P8 at 4× minus 1×, motion                    | −.050                                      | d −.017 ± .020                                     | ≥ −.02               | PASS by mean; CI inconclusive      |
| 7   | `fp_adjacent + fp_noise`, 1×                 | 11.6 / 11.2                                | d +6.2 ± 7.2 / +2.6 ± 4.9                          | CI covers 0 or below | PASS at 1× (but see the 4× note)   |
| 7   | late `adds_pm`, `readds_pm`, 1×              | 22.9 / 20.9; 2.7 / 4.2                     | d −0.2 ± 4.6 / −0.9 ± 3.4; +0.8 ± 1.4 / +0.3 ± 1.6 | CI covers 0          | PASS                               |
| 8   | Late `conv_big4`, sims (last checkpoint)     | .139 / .135                                | d −.018 ± .033 / −.010 ± .018                      | ≤ +.02               | PASS                               |
| 8   | Late `conv_big4`, real (checkpoints ≥ 12000) | .102, .103                                 | .113, .095                                         | ≤ +.02               | PASS                               |
| 9   | Late accepted refines per minute, real       | 46.6, 51.6                                 | 60.2, 53.2                                         | reported             | up 10 %                            |
| 10  | Texture, real, 1 pass                        | 2, 5                                       | 0, 2                                               | 0–7                  | PASS                               |
| 11  | Seed-to-seed Jaccard, real, 1 pass           | .676                                       | .680                                               | ≥ .65                | PASS                               |
| 12  | S8, real                                     | 20 852, 22 485                             | 54 570, 49 460                                     | within spread or up  | PASS (up 2.4×)                     |
| 13  | Audit: published mass beyond `r_h`           | 28.8 %                                     | 1.2 %                                              | ≤ 2 %                | PASS                               |
| 14  | Audit: block leftover, median z              | −0.80                                      | 0.07                                               | \|z\| < 0.2          | PASS                               |
| 14  | Audit: block leftover, share with \|z\| > 3  | 12.0 %                                     | 1.9 %                                              | ≤ 1 %                | **FAIL** (marginal)                |
| 15  | Wall time, max RSS                           | 281 s, 1.23 GB (sims 1×); 676–688 s (real) | 268 s, 1.28 GB; 640–646 s                          | +10 %, +10 %         | PASS (FPS not measured separately) |

Notes on the secondary gates:

- **Gate 14.** The leftover includes partial blocks at the edge of the statistics disk. Those blocks count unmeasured pixels in `n_b`, so their leftover is positive by construction. Restricting to whole blocks would likely pass. Under `basin` the leftover is median z 1.17 with 25 % of blocks at \|z\| > 3. That confirms finding 3: without the skirt, truncation leaves light behind.
- **4× precision (R2).** `skirt` against `ctl` gives P8 −.028 ± .018 (the CI excludes 0), `fp_noise` +6.8 ± 3.0 and `fp_adjacent` +9.4 ± 2.9. R8 is −.007 and R2 +.019. At 4× the extra cells are mostly false positives next to or on noise. This is consistent with risk 1 (cut-off neighbours re-added) or risk 2.
- **R3, pass 3, all edits.** P8 is −.018 ± .020 and −.010 ± .022 (CIs cover 0). R8 is +.014 and +.011, R2 +.024 and +.016. `fp_noise` is +4.6 ± 6.0 and +7.2 ± 5.7, and the static CI excludes 0.
- **Real cells.** `skirt` finds 743 and 740 cells against `ctl`'s 682 and 696, with Minian agreement at ≥ .5 of 537 and 534 against 511 and 525. Under all-edit passes it grows to 894 and 824 cells by pass 3 (ctl: 768 and 765).
- **S8 at about 2× in every `skirt` run.** Sims go from 35.8k to 73.1k (motion) and from 24.2k to 50.4k (static); real goes up 2.4×. `basin` leaves S8 flat. The skirt explains held-out light that the plain moat leaves in the residual. Some of that may be the placebo baseline (placebos are not given skirts); check this before reading it as model quality.

## `basin` against `skirt`

The skirt removes the leftover light: block leftover goes from median z 1.17 to 0.07, and `r_fp` improves by +.009 in both arms. `fp_noise` falls by 2.2 and 1.8. `fp_adjacent` rises by 3.8 and 1.6 (CIs cover 0). P8 and R8 are the same within the CIs.

Only `skirt` diverges in refine-only passes.

## Predictions that do not gate

- **Late `conv_big4` and refines per minute fall.** Falsified for `skirt`: both stayed flat or rose. For `basin` they fell slightly on real data (conv_big4 .095 and .085; refines 42 per minute). The support rule fixes boundedness but is not the churn lever, so the churn target moves to S2.1b.
- **Seed-to-seed Jaccard rises.** Small effect: `skirt` .680, `basin` .693, `ctl` .676.
- **`basin` leaves significant leftover light.** Confirmed (audit above).

## Audit (R5, seed 1; last construction of each final cell)

| arm   | phi median (p10–p90) | z_fw | n_S median | radius | r_h / r_u | mass beyond r_h | skirt blocks | skirt mass / support mass |
| ----- | -------------------- | ---- | ---------- | ------ | --------- | --------------- | ------------ | ------------------------- |
| ctl   | 7.7 (3.1–18.1)       | 3.89 | 800        | 18.0   | 13 / 18   | 28.8 %          | 0            | 0                         |
| basin | 8.5 (3.6–19.4)       | 3.84 | 267        | 12.4   | 12 / 16   | 1.2 %           | 0            | 0                         |
| skirt | 8.2 (3.4–18.6)       | 3.83 | 276        | 12.5   | 13 / 16   | 1.2 %           | 19           | 17.8 %                    |

The measured inflation φ of the smoothed split-half difference is about 8 on real data and 6.8 on a sim smoke run. The white SE understates the noise of the smoothed footprint estimate far more than the unsmoothed 1.8–3.9 of S2.0b. As a result the significant support is compact: median radius 12.5 px against 18 px under `ctl`.

## Files

- **Reports.** `reports/`: `r1_*.md`, `r2_skirt.md`, `r3_pass3_skirt.md`, `r5_audit.md`, `churn_*_s1.md`.
- **Runs.** `runs/r{1,2,3,4}`, `real/r{5,6,7}`, and `queue.log`.
- **Tools.**
  - `tools/cala-eval/support_sizes.py` (new; generalises `s23b/support_agg.py`);
  - `summarize.py`, `split_passes.py`, `seed_jaccard.py` and `churn_attribution.py`;
  - `s23b/evalrun.py` for real texture, S8 and Minian agreement;
  - the audit summary `s21support/audit_sum.py`.
