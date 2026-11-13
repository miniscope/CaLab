# S2.1b: a stable skirt (the column carries the skirt's own low-pass)

12 Nov 2026. Follow-up to `2026-11-12-support-rule.md`. Binary `qc_eval-fix2` was built from this branch
(`feat/cala-skirt-stability`, stacked on #344) with `--features diagnostics`. The sims, flags and seeds are the same as in the
S2.1 note: `$CALA_SIMS` (`sims/`, minisim 1.0.3 `detectable` flags), `--batch 8 --budget 30000000 --slow-seed 1`.
Controls are reused from S2.1:

- `ctl` and `basin` are the S2.1 runs. Neither has a skirt, so this change leaves its columns and placebos unchanged.
- `old skirt` is the S2.1 `skirt` arm (#344 as opened).
- `skirt` is this branch.

Paths refer to the scratch directory `scratchpad/s21b-skirt`, which is not in the repo.

## Verdict

**The divergence is fixed at its cause, and `BasinSkirt` passes every gate it failed except two.** No run diverges: 10 of 10
refine-only sims and 4 of 4 real runs stay finite, and the sweep cap is never hit after pass 1. S8 is no longer inflated, and
precision is within the 1× margins. The two gates that still fail are statistics that cannot pass as defined:

- the block-leftover `|z| > 3` share is zero by construction on whole blocks, and positive by construction on partial ones;
- the median support ratio measures growth of compact first-pass supports, which converges on sims.

Recommendation: flip the default to `BasinSkirt` once the PI accepts the two redefinitions below. The 4× precision cost
(P8 −.021 ± .024 against `ctl`) is the remaining risk. It is smaller than before, but all five seeds are negative.

## Decision (12 Nov 2026)

The PI accepted both redefinitions and approved `BasinSkirt` as the default (`SlowLoopConfig::support_rule`, `qc_eval`
and `discover_eval`; the app takes the library default). `--support-rule rings` stays selectable for comparisons.

1. **Gate 14 drops the block-leftover `|z| > 3` share.** Whole blocks are 0 by construction and partial edge blocks are
   positive by construction (§3), so the share cannot discriminate. Leftover light is judged by the median leftover z
   (|z| < 0.2), the mass beyond `r_h` (≤ 2 %), and the held-out S8 and `ho_marginal_z` against placebos.
2. **The sims median support ratio p3/p1 > 1.10 is read as converge-up, not drift.** It comes from compact first-pass
   supports in the smallest tercile growing to their extent, and the paired per-cell p3/p2 is 1.000 in every run (§4).
   The bounded-support gates are p99 and the largest footprint, which pass.

With these, every primary gate passes. A longer real refine-only run (5 passes) checks whether the real median growth
settles; see §5.

## 1. Root cause of the fast-loop divergence

**Reproduction.** `static_s7` refine-only under `basin-skirt` blows up at frame 12462, at library v250 in pass 2. That is
the same frame as in R4. The probe (`CALA_DIVERGE_DIR`) shows the precursor: from frame 8050 in pass 1, frames hit the solver's
200-sweep cap while the traces stay bounded (207 frames by 8831, 7835 in all). `basin` on the same sim hit the cap 0 times in
27 933 frames.

**Mechanism.** In the ring model each cell has its own local level, so the coordinate update solves
`M c = b − s ∘ ring` with `M_ij = G_ij − s_i q_ij`. Here `s_i` is the column sum and `q_ij` is the ring mean of column `j` in
ring `i`. `M` is not symmetric, so SOR has no convergence guarantee. With high-pass columns, `s_i ≈ 0` keeps the coupling
negligible.

The #344 skirt column was `H a_S` plus the bare skirt block means. The moat stayed the low-pass of the support alone, so the
skirt's negative lobe was missing and its mass became DC. On the dumped v250 library:

| Quantity                                                         | Value                       |
| ---------------------------------------------------------------- | --------------------------- |
| median `s_i / G_ii`, skirt cells (407 of 502)                    | **0.31** (non-skirt: 0.005) |
| growth per sweep, homogeneous unconstrained SOR, ω = 1.5         | **1.55** (unstable)         |
| same, ω = 1.0 (plain Gauss–Seidel)                               | **1.20** (unstable)         |
| Gram alone, ω = 1.5                                              | 0.73                        |
| `s_i` zeroed on the skirt cells only                             | 0.73 / 0.79 (stable)        |
| `s_i` zeroed on the non-skirt cells only                         | 1.56 / 1.20 (unstable)      |
| replay of the dumped frame (library bytes, frame and warm start) | bit-identical to the run    |

All 502 cells form one overlap group. The earlier hypothesis, that skirt light entering the neighbours' ring makes the ring
solve indefinite, was close but not the actual defect. The defect is the column's DC. Lowering ω would not have helped,
because even Gauss–Seidel diverges.

**Fix (principled, no constants).** The skirt is unfiltered light. The column is the filter applied to the whole footprint
`f = a_S + u`, where `u` is the block-constant skirt field on the FOV pixels outside `S` (`skirt_field`). The moat reaches as
far beyond the skirt blocks as beyond the support (`skirt_radius`), so the column sums to about 0 like every filtered
footprint.

The skirt values solve `u = c + K u` exactly per construction:

- `c` is the block mean of `h + L a`;
- `K_bc` is the block mean of `L` applied to block `c`'s skirt pixels;
- the solve is a dense one of 10 to 30 unknowns.

The column therefore still equals the measured light per block on the disk, which is the plan's guarantee. A unit test on a
256 px frame measures the share of the skirt's mass left as column DC: −0.004 now, ≈ 1 before; the support's own share is
0.011.

On the same frame and version after the fix:

- all groups are stable (0 unstable at ω = 1.5 or ω = 1.0);
- the median `s_i / G_ii` is −0.007 for skirt cells;
- the p90 is about 0.3 in both classes, which is FOV-edge cells, as under `basin`.

## 2. S8 at about 2×

The 2× was mostly the DC, not the placebos. The held-out χ² does not render the ring level, so a column with positive DC
soaks up local background. The placebos were also unfair, for two reasons:

- the augmented placebo library rebuilt the real cells without their skirts;
- placebos had no skirt.

Both are fixed: real cells keep their skirts, and a placebo of a skirt cell carries the skirt, moved by whole 8 px blocks.

Attribution on `static_s7`, pass-1 S8:

| Variant                  | S8     |
| ------------------------ | ------ |
| `ctl`                    | 30 406 |
| old skirt                | 54 624 |
| DC fix only              | 32 792 |
| DC fix and fair placebos | 30 628 |

## 3. Block leftover `|z| > 3`

The audit now splits blocks into two classes. A whole block has every FOV pixel outside `S` measured and outside `X`. All
other blocks are partial. Results on R5 seed 1, real data:

| Arm       | Overall | Whole blocks            | Partial blocks |
| --------- | ------- | ----------------------- | -------------- |
| skirt     | 2.5 %   | **0.00 %** (4085, 29 %) | 3.5 %          |
| old skirt | 1.9 %   | not split               | not split      |

All of the excess sits in partial blocks.

On a whole block the skirt is the block mean of exactly the audited pixels, so the leftover is zero by construction, both
before and after this fix. The statistic tests the arithmetic, not the model.

On a partial block, unmeasured pixels count as zero light by design ("a block mostly outside the disk stays close to the
plain moat"). The measured part therefore carries a positive leftover by construction.

The gate as written cannot discriminate, and fixing the coverage would mean extrapolating light into unmeasured pixels.
Proposal: drop gate 14's `|z| > 3` share. Keep the median z (0.10) and mass beyond `r_h`, and judge leftover light by held-out
S8 and `ho_marginal_z` against fair placebos.

## 4. Median support, pass 3 / pass 1 (secondary)

The paired per-cell analysis (`tools/paired_growth.py`) gives a different picture from the ratio of population medians:

- **Sims, R4.** The pass-3 / pass-2 ratio per cell is 1.000 in every run, for `basin`, the old skirt and the new skirt. The
  growth in pixels from pass 2 to 3 is 0.33 of the growth from pass 1 to 2. That is close to 0.27, the value predicted by a
  threshold falling as `n^-1/2` with the statistics' 6000-frame half-life.
  - All growth is in the smallest pass-1 tercile (median 178 px): ×2.1 from pass 1 to 3, flat from pass 2 to 3.
  - The largest tercile is flat (1.000).
  - **This is a converge-up from compact first-pass supports (φ ≈ 8), not drift.** The 1.18 median ratio is that tail.
- **Real, R7.** The median cell grows ×1.29 from pass 1 to 2 and ×1.06 from pass 2 to 3, so it decelerates. p99 is bounded
  at 0.97. But the 2→3 / 1→2 increment ratio (.56–.63) is larger than the half-life mechanism predicts (≈ .13 for
  18 000-frame passes). Another ratchet may add to it, for example the statistics disk following the support. This is
  unverified, and the same numbers were seen before the fix (old skirt 1.63, new 1.65). The 5-pass run in §5
  answers this: the second ratchet is the split-half inflation φ settling, and it is decaying.

## 5. Real refine-only, 5 passes (R8)

Same binary (`qc_eval-fix2`) and flags as R7, with `--passes 5` (`real/r8` in the `s21c-default` scratch directory). Passes
1–3 of seed 1 are byte-identical to R7. The Rings control is one seed. Sizes count positive pixels.

| Pass | skirt s1: cells, median / p90 / p99 / max | skirt s2: cells, median / p90 / p99 / max | ctl (rings) s1: median / p99 / max |
| ---- | ----------------------------------------- | ----------------------------------------- | ---------------------------------- |
| 1    | 730, 234 / 460 / 820 / 1146               | 763, 225 / 496 / 900 / 1298               | 490 / 3171 / 5658                  |
| 2    | 731, 348 / 534 / 822 / 979                | 762, 342 / 523 / 743 / 1022               | 1164 / 15 573 / 111 450            |
| 3    | 731, 382 / 581 / 859 / 1175               | 762, 378 / 582 / 798 / 1156               | 1514 / 28 344 / 193 865            |
| 4    | 731, 400 / 604 / 882 / 1108               | 762, 408 / 616 / 890 / 1230               | 1728 / 65 271 / 283 173            |
| 5    | 731, 411 / 629 / 950 / 1208               | 762, 416 / 624 / 906 / 1247               | 1862 / 128 777 / 283 152           |

Paired per-cell median `n_{k+1}/n_k` (cells present in all 5 passes, pass-1 size tercile), and the share of cells growing or
shrinking by more than 5 % per step:

| skirt, s1 / s2 | 2/1           | 3/2           | 4/3           | 5/4           |
| -------------- | ------------- | ------------- | ------------- | ------------- |
| small tercile  | 1.663 / 1.615 | 1.081 / 1.087 | 1.000 / 1.032 | 1.000 / 1.000 |
| mid tercile    | 1.386 / 1.429 | 1.060 / 1.087 | 1.000 / 1.051 | 1.000 / 1.000 |
| large tercile  | 1.000 / 1.000 | 1.045 / 1.034 | 1.000 / 1.028 | 1.000 / 1.000 |
| all            | 1.291 / 1.301 | 1.058 / 1.065 | 1.000 / 1.036 | 1.000 / 1.000 |
| grow > 5 %     | .67 / .65     | .52 / .52     | .35 / .46     | .28 / .27     |
| shrink > 5 %   | .16 / .19     | .09 / .09     | .09 / .06     | .08 / .12     |
| sum of Δ px    | 55k / 51k     | 31k / 32k     | 16k / 27k     | 12k / 9k      |

Per pass (evalrun), skirt s1 / s2: texture 0 in every pass; S8 22–25k, flat after pass 2 (s1 22 259 → 24 714, s2 22 809 →
24 213); Minian agreement ≥ .5 rises 531 → 577 and 535 → 591; cells 731 / 762 throughout. The Rings control runs away as in
S2.1: p99 ×40, texture 2 → 61, S8 21.9k → 445k, 140 min wall and 2.0 GB RSS against 51 min and 1.07 GB for skirt.

**Reading.** The typical cell has stopped by pass 4: the paired median ratio is 1.000 for every tercile at 5/4 in both
seeds. The pixel increments shrink by about half per pass, and p99 stays within 1.16 of pass 1. But growth has not fully
stopped: about 27 % of cells still grow by more than 5 % from pass 4 to 5, against 8–12 % that shrink, so the population
median still creeps (+3 %, +2 %). A geometric tail at the observed decay would add about 20 px per cell. Growth does not
persist per cell: P(grow at step k | grew at k − 1) equals the base rate (.27 vs .28). Only 6–7 % of cells grow more than 5 %
at every step. Growth is also independent of peak SNR and of neighbour distance. The new pixels sit at the edge (1.1 ×
equivalent radius) at about 0.10 of the peak, in pixels that neighbouring supports already cover.

**What drives it (audit rerun of seed 1, `CALA_SUPPORT_AUDIT`, last construction per cell and pass).** The threshold
`z_fw φ se` falls 0.311 → 0.129 → 0.107 → 0.090 → 0.085, the medians over cells per pass. Its parts move as follows:

- `se` reaches its half-life equilibrium by pass 3 (0.0095 → 0.0045 → 0.0039 → 0.0038 → 0.0037). It is uncorrelated with growth
  after pass 2 (Spearman ≈ 0). The 6000-frame forgetting is therefore not what drives the late growth.
- **The second ratchet is the split-half inflation `φ`.** It falls 8.34 → 7.42 → 6.59 → 5.45 → 5.38, by −11 %, −15 % and
  then −3 % per step. Growth correlates with the fall (Spearman −.27, −.33, −.19). In the 4→5 step, φ falls by 10 % in the
  growing cells against 0.3 % in the rest. `φ` measures how much the two halves of the statistics disagree beyond white noise.
  It falls as the model around a cell becomes stationary, because fewer edits change the residual the halves see
  (statistics-path constructions per pass: 31.6k, 26.5k, 23.8k, 22.3k). The `φ` decline has nearly stopped (−3 %), so this
  driver is running out.
- **A smaller contribution comes from the statistics disk following the support.** The disk is the support radius + 0.4
  diameters and moves when the support outgrows it. Median `N` rises 771 → 1018, and `z_fw` rises slightly with it. Growth
  correlates with disk growth (Spearman +.45, +.32, +.27). In the 4→5 step, the disk grew in 24 % of growing cells against
  3 % of the others. A larger disk exposes more pixels to the basin test, but so far it has not produced runaway (p99 ≤ 1.16).

Not fixed here. Both drivers are decaying, and the median is flat per cell from pass 4. A longer run (8–10 passes) would show
whether the residual creep goes to zero or settles into a slow drift through the disk-following loop.

## Gate table

R4 and R7 are refine-only 3-pass runs. Sims use 10 seeds; real data uses seeds 1 and 2. Differences are paired by seed, mean
d ± 95 % CI.

| Gate                                        | ctl               | basin          | old skirt                | **skirt**                           | Pass if                  | Result                                      |
| ------------------------------------------- | ----------------- | -------------- | ------------------------ | ----------------------------------- | ------------------------ | ------------------------------------------- |
| Sims runs with a footprint > 50k px         | 7/7               | 0/10           | 0/10                     | **0/10**                            | 0                        | PASS                                        |
| Sims runs with explained < .85 after pass 1 | 5/7               | 0/10           | 2/10                     | **0/10** (min .878)                 | 0                        | PASS (was FAIL)                             |
| Fast-loop divergence (traces > 1e6)         | —                 | 0/10           | 2/10                     | **0/10 sims, 0/4 real**             | 0                        | PASS                                        |
| Sweep-cap frames after pass 1               | —                 | —              | thousands                | **0** (14 runs)                     | —                        | —                                           |
| Sims median, pass 3 / pass 1                | 1.55              | 1.15           | 1.15                     | 1.18 (paired 2→3: 1.000)            | ≤ 1.10                   | converge-up (§4); redefined, accepted       |
| Sims p99, pass 3 / pass 1                   | 8.72              | 0.96           | 0.94                     | **0.88**                            | ≤ 1.25                   | PASS                                        |
| Real p99, pass 3 / pass 1 (R7)              | 11.8              | —              | 1.06                     | **0.97**                            | ≤ 1.25                   | PASS                                        |
| Real texture at pass 3 (R7)                 | 32, 27            | —              | 0, 1                     | **0, 0**                            | ≤ 9                      | PASS                                        |
| Largest footprint at pass 3, sims / real    | 320k / 207k       | 1680 / —       | 1468 / 1572              | **1346 / 1166**                     | —                        | —                                           |
| P8, 1× vs ctl (motion / static)             | .930 / .953       | —              | −.011 / −.007            | **−.010 ± .021 / −.011 ± .017**     | ≥ −.02                   | PASS by mean, CI covers 0                   |
| R8, 1×                                      | .751 / .781       | —              | +.018 / +.014            | **+.010 ± .013 / +.007 ± .014**     | ≥ −.02                   | PASS                                        |
| R2, 1×                                      | .535 / .582       | —              | +.024 / +.017            | **+.021 ± .023 / +.010 ± .005**     | ≥ −.05                   | PASS                                        |
| `r_fp`                                      | .945 / .973       | −.010 / −.011  | −.002 / −.001            | **−.002 ± .003 / −.003 ± .003**     | ≥ −.010                  | PASS                                        |
| `fp_noise`, 1×                              | 5.2 / 7.2         | —              | —                        | +0.4 ± 3.6 / +2.2 ± 5.3             | CI covers 0              | PASS                                        |
| `fp_adjacent`, 1×                           | 6.4 / 4.0         | —              | —                        | +3.4 ± 6.7 / +0.8 ± 1.6             | CI covers 0              | PASS                                        |
| P8 at 4× minus 1×, motion                   | −.050             | —              | −.067                    | **−.061** (d −.011)                 | ≥ −.02                   | PASS                                        |
| P8 at 4× vs ctl                             | .880              | —              | −.028 ± .018             | **−.021 ± .024** (signs 0/5)        | reported                 | improved; still the weakest point           |
| `fp_noise` at 4× vs ctl                     | 15.2              | —              | +6.8 ± 3.0               | +5.4 ± 4.9                          | reported                 | —                                           |
| Late `conv_big4`, sims                      | .139 / .135       | —              | −.018 / −.010            | **−.012 / −.014**                   | ≤ +.02                   | PASS                                        |
| S8, sims 1×                                 | 35.8k / 24.2k     | —              | 73.1k / 50.4k            | **+255 ± 403 / +169 ± 202**         | not inflated             | PASS (was 2×)                               |
| S8, real (R5 seeds 1 and 2)                 | 20 852, 22 485    | 22 727, 22 238 | 54 570, 49 460           | **22 259, 22 809**                  | not inflated             | PASS                                        |
| Texture, real, 1 pass                       | 2, 5              | 1, 0           | 0, 2                     | **0, 0**                            | 0–7                      | PASS                                        |
| Minian agreement ≥ .5, real (R5)            | 511, 525          | 540, 541       | 537, 534                 | 531, 534                            | reported                 | —                                           |
| Minian agreement ≥ .5, R7 passes 1/2/3      | —                 | —              | 537/564/569, 534/562/567 | 531/564/572, 535/576/583            | reported                 | —                                           |
| Seed-to-seed Jaccard, real                  | .676              | .693           | .680                     | **.697** (R7 pass 3: .740)          | ≥ .65                    | PASS                                        |
| Audit: mass beyond `r_h`                    | 28.8 %            | 1.2 %          | 1.2 %                    | **1.0 %**                           | ≤ 2 %                    | PASS                                        |
| Audit: block leftover, median z             | −0.80             | 1.17           | 0.07                     | **0.10**                            | \|z\| < 0.2              | PASS                                        |
| Audit: block leftover, share with \|z\| > 3 | 12.0 %            | 25.2 %         | 1.9 %                    | 2.5 % (whole 0.00 %, partial 3.5 %) | ≤ 1 %                    | dropped (not discriminating, §3)            |
| `ho_marginal_z` median, real (R5)           | 6.46, 6.58        | 6.70, 6.52     | 9.28, 9.85               | 5.39, 6.10                          | reported                 | lower against placebos that now have skirts |
| Wall time, sims 1× / real                   | 281 s / 676–688 s | —              | 268 s / 640–646 s        | 258 s / 600–617 s                   | +10 %                    | PASS                                        |
| Max RSS                                     | 1.23 GB           | —              | 1.28 GB                  | 1.47 GB                             | +10 % (sims 1×: 1.27 GB) | PASS                                        |

Wall times were measured with 4 to 6 runs in parallel, so they are coarse.

**Pre-existing, not skirt-specific.** Early in pass 1 the ring solve sometimes hits the 200-sweep cap with bounded traces.
On `static_s5` this happens in 700 frames under `ctl` (main), 1292 under `basin` and 972 under `skirt`. On `static_s8` the
counts are 36, 193 and 184. It never happens in later passes. This is a candidate follow-up: the ring model is a
non-symmetric coupled solve with no convergence guarantee, even under `Rings`.

## Identity

`--support-rule rings` (the default) is byte-identical to main be6bff3 on `$SIM_MOTION_S5`: 9600 frames,
`--churn-log`, every tsv, `footprints.bin` and `fp_history.bin`. The 2400-frame `--via-jobs` run is also identical.

## Files and commands

- **Runs.**
  - `runs/r1/skirt` and `runs/r2/skirt`: `run_arms.py`, the same flags as in S2.1;
  - `runs/r4/skirt`: `--passes 3 --later-passes refine`, each with `diverge/solver.tsv`;
  - `real/r5`, `real/r7`: the same flags as in S2.1;
  - `capcheck/` (`--no-heldout`, 1 pass);
  - `repro1/`, `repro/` and `fix1/`: the divergence reproduction and the first fix run.
- **Reports.** `reports/r1_*`, `reports/r2_*`, `reports/r4_sizes.md`, `reports/r7_sizes.md`, `reports/real_eval.txt`,
  `growth_old_r4.md`, `reports/r4_paired_growth_new.md`.
- **Tools.**
  - `tools/paired_growth.py` (scratch);
  - `tools/audit_sum.py` (S2.1's, with the whole/partial columns);
  - the offline replay and SOR analyser `probe_tests.rs`, a scratch test module run with
    `CALA_PROBE_DUMP=<dump> cargo test --release --lib probe -- --ignored`.
