# Cluster history replay (Stage 1, Refine only, flag off by default)

17 Nov 2026. Branch `feat/cala-cluster-replay`. Design: `~/Projects/cala-data/demix-bench/design_joint_update.md`
(Stages 0 and 1; a "Stage 1 results" section there has the diagnostics in full). Runs and scripts are in
`~/Projects/cala-data/demix-suite/` (`quick-replay1`, `full-signall`, `sub-sign`, `sub-bgnone`) and
`~/Projects/cala-data/runs/replay/`, with `demix-bench/replay_extra.py` (over-fill share, RSS, slow-loop cost) and
`demix-bench/replay_dump_analyze.py` (raw replay estimate). They are not in the repo.

## The change

`SlowLoopConfig::joint_update` (`qc_eval --joint-update off|refine|all`, default `Off`). With `Refine`, in the Refine
stage (`EditScope::Refine`, the cell set frozen):

- **Clusters.** Cells are joined along normalised whitened Gram overlaps `ρ = G_ij / sqrt(G_ii G_jj) ≥ 0.05`, strongest
  first, at most 6 per cluster (`cluster_rho_min`, `cluster_max`). Singletons keep the per-cell statistics unchanged.
- **Store** (`discover/cluster.rs`). Per cluster, on the union of the members' statistics disks: the forgetting sums `CY
= Σ w r̃ ĉᵀ` of the whitened cluster residual, and per fitting frame the K numbers `v_t = Uᵀ r̃_t` in the basis `U =
orth(CY)`, at most `stats_half_life_frames` frames. Held-out frames are never stored. The frames are kept behind a
  `ClusterHistory` trait (append, re-express in a new basis, iterate), so a compressed frame store can back it later.
- **Replay** (one per refine visit, on the tile holding the cluster's first member). Refresh the basis, re-solve every
  stored frame's traces with the current footprints (non-negative), refit the footprints jointly per pixel, each member's
  coefficient ≥ 0 on its disk (`JointSign::All`, see below). Each member's estimate and split halves go through the
  existing finish path (basin support, inversion), and the members' new columns are **gated together** (paired held-out
  gain > 0, `refine_z`). Members of a cluster with a usable replay skip the per-cell refinement.

The flag adds three settings (`cluster_rho_min`, `cluster_max`, `joint_sign_rule`) and one experimental knob
(`joint_iters`, 1). No size cap, no sparsity penalty, no new pixel constants (the window is the statistics half-life,
the pixel margin the statistics margin).

## Stage 0: clusters and cost (static s5, end of Discover and of Refine)

| ρ_min | clustered cells (of 518) | uncut component sizes               | after the cap of 6     | edges cut | pairs < 1 D (10 px) in one cluster |
| ----- | ------------------------ | ----------------------------------- | ---------------------- | --------- | ---------------------------------- |
| 0.03  | 342                      | 2:60 3:25 4:9 5:8 6:4 7:4 8:1 11:1  | 2:62 3:27 4:12 5:9 6:7 | 9         | 87 / 87                            |
| 0.05  | 323                      | 2:61 3:24 4:10 5:6 6:2 7:4 8:1 11:1 | 2:63 3:26 4:13 5:7 6:5 | 8         | 87 / 87                            |
| 0.1   | 273                      | 2:66 3:23 4:7 5:4 6:1 8:1 10:1      | 2:67 3:23 4:8 5:4 6:3  | 3         | 84 / 87                            |

ρ by centre distance (config D = 10 px; the GT soma is 14.5 px): median 0.43-0.48 below 0.75 D, 0.32 at 0.75-1 D,
0.18 at 1-1.25 D (94 % ≥ 0.05), 0.10 at 1.25-1.5 D (81 %). ρ ≥ 0.05 catches every pair closer than one GT diameter.
About 15 % of clustered cells sit in uncut components larger than 6; the cap cuts only 3-8 edges, all weak.

**Motion s5** (end of Refine, 557 cells): at ρ ≥ 0.05, 376 cells clustered (uncut sizes 2:52 3:24 4:12 5:7 6:5 7:3 8:3
9:1 10:2 13:1; after the cap 2:56 3:26 4:13 5:10 6:13, 16 edges cut); 129 of 138 pairs closer than 1 config D have
ρ ≥ 0.05 and all 129 stay in one cluster. No cluster frame was skipped for missing pixels (`skipped_frames` 0), and
stores restarted 217 times for 123 clusters (a member's statistics disk leaving the cluster's pixels).

Slow-loop `observe` per frame, `--features diagnostics` timers, each run alone on the machine:

| sim       | Discover: observe / per-cell statistics | Refine with replay: observe / per-cell / cluster push |
| --------- | --------------------------------------- | ----------------------------------------------------- |
| static s5 | 1.95 / 0.89 ms (46 %)                   | 3.39 / 1.10 / 1.08 ms (before vectorising the push)   |
| motion s5 | 2.04 / 0.96 ms (47 %)                   | 3.26 / 1.20 / 0.86 ms                                 |

The cluster push costs about as much as the per-cell statistics: the clusters cover about 3x the pixels the design
assumed (disks plus the statistics margin plus one more margin) and the stores hold 38-43 MB, not 10-12. The QC
monitor's ms/frame (the suite's row) does not include the slow loop.

## Results: main (flag off) vs replay, full tier (14 sims: static s5-s9, motion s5-s9, pairs s5-s8)

`qc_eval sim ... --passes 2 --later-passes refine`; candidate adds `--joint-update refine --joint-sign all`. With the
flag off the binary's output is identical to main (see "Reproduction" below).

| metric                                           | main        | replay      | diff [95 % CI]          | sims agreeing | flag                |
| ------------------------------------------------ | ----------- | ----------- | ----------------------- | ------------- | ------------------- |
| **Trace corr excess < 1 D (headline)**           | +0.150      | +0.106      | -0.044 [-0.053, -0.032] | 14/14         | better              |
| Trace corr excess 0.5-1 D                        | +0.127      | +0.088      | -0.040 [-0.050, -0.031] | 13/14         | better              |
| Bite share ratio < 0.5, 0-0.5 D                  | 0.382       | 0.193       | -0.189 [-0.231, -0.146] | 13/14         | better              |
| Bite share, 0.5-0.75 D                           | 0.353       | 0.203       | -0.151 [-0.181, -0.120] | 13/14         | better              |
| Bite share, 0.75-1 D                             | 0.486       | 0.338       | -0.148 [-0.180, -0.115] | 13/14         | better              |
| Bite ratio median 0.75-1 D                       | 0.520       | 0.763       | +0.243                  | 14/14         | better              |
| leak_sd median < 1 D                             | 0.058       | 0.041       | -0.017                  | 14/14         | better              |
| leak_sd share > 0.1                              | 0.358       | 0.276       | -0.082                  | 14/14         | better              |
| Matched cells                                    | 400.1       | 401.3       | +1.1 [0.3, 2.0]         | 9/14          | within noise        |
| False cells                                      | 21.9        | 20.7        | -1.1 [-2.0, -0.3]       | 9/14          | within noise        |
| Final cells matching 2+ GT units (r ≥ 0.5)       | 148.6       | 166.5       | +17.9 [11.6, 24.1]      | 14/14         | worse (see below)   |
| Close GT pairs both matched, 0.25-0.5 D          | 25.2        | 27.1        | +1.9                    | 10/14         | better              |
| Close GT pairs both matched, 0.5-0.75 / 0.75-1 D | 61.4 / 87.2 | 61.3 / 87.1 | -0.1 / -0.1             |               | within noise        |
| Merge edits, splits                              | 28.9, 6.6   | 28.9, 6.6   | 0                       |               | (Refine makes none) |
| Median support area (px)                         | 603         | 630         | +27                     | 13/14         | changed             |
| Median half-max area (px)                        | 151         | 152         | +2                      | 11/14         | changed             |
| QC ms/frame                                      | 0.327       | 0.327       | 0.000                   |               | within noise        |

Per-bin trace correlation excess (median r minus the 1.5-3 D median):

| sims                  | 0-0.5 D         | 0.5-0.75 D      | 0.75-1 D        |
| --------------------- | --------------- | --------------- | --------------- |
| static, main → replay | +0.289 → +0.241 | +0.156 → +0.102 | +0.095 → +0.060 |
| motion                | +0.326 → +0.286 | +0.192 → +0.148 | +0.104 → +0.075 |
| pairs                 | +0.333 → +0.269 | +0.210 → +0.144 | +0.106 → +0.033 |

Over-fill (`est_at_cj / true_at_cj > 1.3`, pairs < 1 D, `replay_extra.py`): 0.059 → 0.067 overall (0.75-1 D 0.073 →
0.088); next to a GT unit not in the final library 0.092 → 0.090. Peak RSS median 1060 → 1027 MB (max 1632 → 1715);
the stores hold 38 MB at most on static s5. Slow-loop `observe` in the Refine pass 2.29 → 2.97 ms/frame (+30 %); wall
per run 411 → 436 s.

**"2+ GT units" up.** The close-pair resolution (both neurons of a GT pair matched) is unchanged or better in every bin
and the matched count is not down, so these are not lost cells: footprints that took back light under a neighbour's
centre now correlate ≥ 0.5 with that neighbour too (the suite notes the metric over-counts neighbours; support area
+27 px).

## Against the design's targets

| target                                               | result                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| bite share ≤ 0.25 at 0.5-1 D                         | 0.5-0.75 D: 0.203, met. 0.75-1 D: 0.338, **not met** (from 0.486)                     |
| corr excess ≤ +0.10 (0.5-0.75 D), ≤ +0.05 (0.75-1 D) | static +0.102 / +0.060, motion +0.148 / +0.075, pairs +0.144 / +0.033: close, not met |
| ratio > 1.3 share ≤ 5 %                              | 6.7 % (main 5.9 %); next to undetected units 9.0 % (main 9.2 %)                       |
| matched within 1 %, false within +1, merges ± 10 %   | met (+1.1, -1.1, merges unchanged)                                                    |
| ms/frame ≤ +15 %, RSS ≤ +20 MB                       | QC ms/frame and RSS unchanged; slow-loop observe +30 % in Refine (over)               |

## What decides it: the sign rule and the support step

- **Sign rule.** The first build fitted footprints per pixel by plain least squares (filtered space, where the moat is
  negative). On the quick tier it lowered the 0.75-1 D bite share 0.50 → 0.42 and did not lower the correlation excess
  (+0.142 → +0.157, within noise). Constraining only where a member's current column is positive (`JointSign::Own`)
  changed nothing. The toys' rule, every member ≥ 0 on its whole disk (`JointSign::All`), gave the table above. Without
  it the rotation between a bitten newcomer and its over-filled neighbour is a free direction of the footprint fit
  (`A R`, `R⁻¹ C`); only the clip of the newcomer's light on the older cell's far side pins it.
- **Raw replay estimate** (static s5, `CALA_REPLAY_DUMP`: member i's filtered value at j's centre over its own value,
  final replay). Fixed pair set: the 196 GT pairs at 0.5-1 D that main leaves bitten (published ratio < 0.5), and 147
  healthy ones (0.7-1.3); ids are the same in every arm (pass 1 is identical, Refine freezes the cell set).

  | arm                        | raw, bitten set | raw, healthy set | published est/true median, bitten set | still < 0.5 |
  | -------------------------- | --------------- | ---------------- | ------------------------------------- | ----------- |
  | plain fit, 1 alternation   | +0.029          | +0.108           | 0.00                                  | 70 %        |
  | plain fit, 10 alternations | -0.005          | +0.003           | 0.00                                  | 78 %        |
  | `All`, 1 alternation       | +0.036          | +0.137           | 0.33                                  | 60 %        |
  | `All`, 10 alternations     | +0.107          | +0.179           | 0.00                                  | 65 %        |

  With the sign rule, more alternations in the store bring the raw estimate of bitten pairs close to healthy pairs', but
  the published footprints do not follow (and 10 alternations raise over-fill to 11.5 % and inflate healthy pairs).
  Something after the replay, the per-member finish path (support, inversion) or the cluster gate, holds the bite back.
  That points to the design's Stage 2 (cluster support rule) as the likely next lever. It is a lead, not yet a
  measurement of which step it is.

- **Ring background.** Bite share at 0.5-0.75 / 0.75-1 D on static s5 and pairs s5-s6, main and replay (plain fit): with
  the ring 0.330 / 0.559 and 0.244 / 0.488; with `--bg none` 0.325 / 0.589 and 0.351 / 0.577. Without a background the
  bites are no smaller and the replay gains nothing; the ring is not what makes the bite.

## Replay in Discover too (pass 1 only, quick tier)

`--passes 1`, main vs `--joint-update all` (the same code path called from Discover visits; a store restarts whenever
its cluster's member set changes, 88 cluster rebuilds on static s6, so stores stay young: 770 replays in pass 1 against
about 8000 in a Refine pass):

| metric                                 | main pass 1           | replay in Discover    | diff                    | sims     |
| -------------------------------------- | --------------------- | --------------------- | ----------------------- | -------- |
| Trace corr excess < 1 D                | +0.147                | +0.112                | -0.035 [-0.054, -0.018] | better   |
| Bite share 0-0.5 / 0.5-0.75 / 0.75-1 D | 0.473 / 0.479 / 0.669 | 0.340 / 0.314 / 0.507 | -0.13 / -0.17 / -0.16   | 5/5 each |
| Matched cells                          | 346.8                 | 338.4                 | -8.4 [-17.1, 0.3]       | 4/5 down |
| False cells                            | 15.0                  | 15.2                  | +0.2                    |          |
| Over-fill (ratio > 1.3)                | 0.059                 | 0.054                 |                         |          |
| Slow-loop observe                      | 1.77 ms/frame         | 2.16 ms/frame         | +22 %                   |          |

Demixing improves in Discover alone about as much as one Refine pass of main gives, but matched cells fall 2.4 %, over
the design's 1 % limit for Discover: not a candidate as is (absorption guard and store re-expression first).

## Reproduction

The PR's HEAD, flag off and `--joint-update refine` alone (sign rule `All` is the default), reproduces the measured
arms byte for byte on pairs s5 (`footprints.bin`, `footprints_pass1.bin`, `final.tsv`), and the flag-off arm's static
s5 `footprints.bin` and `final.tsv` are identical to main's (`z0` arm of the suite's validation run).

## Caveats

- `JointSign::All` clips in filtered space, the moat included; the moat comes back through the finish path's inversion.
  The alternative of clipping in unfiltered space (invert, clip, re-filter) was not tested.
- The reading of the "2+ GT units" rise (footprints that took back light under a neighbour, not merges) agrees with the
  close-pair table but was not checked footprint by footprint.
- The demixing suite is `tools/cala-eval/demix_suite.py` (#420).

## Not done (later stages)

The cluster support rule (Stage 2), replay in Discover (`JointUpdate::All` exists and runs, but a membership change
restarts a store, which suits Refine only), wire serialisation of the stores (done in `results/2026-11-18-replay-worker-jobs.md`; before it a `VisitRunner` job carried none and its
visit fell back to the per-cell path), and the cost work of Stage 4.
