# Look-back metrics: validation (17 Nov 2026)

Validation of the look-back additions to the demixing suite (`demix_stages.py`, birth-order / late-born / undetected-neighbour rows, cluster tables) on a small subset: `static_s5` and `pairs_s5`, refine gate `--refine-z 3` (z3) against `--refine-z 0` (z0), binary built from this branch (qc_eval with `--lib-at`, `--wrap-libs`). Two sims, so every CI is wide and the seeds column of the suite table can only read 1/1 or 2/2: this shows that the tables render and read sensibly, it is not a result about the gate. The 14-sim full tier is the place for that.

Commands (one qc_eval at a time per arm; about 12 min main run + 8 extract runs of about 1.5 min per sim and arm):

```
$MINISIM_PY tools/cala-eval/demix_stages.py run --label z3 --flags "--refine-z 3" --bin <qc_eval of this branch> --only static_s5,pairs_s5 --name lookback-z3-vs-z0
$MINISIM_PY tools/cala-eval/demix_stages.py run --label z0 --flags "--refine-z 0" ...   (same)
$MINISIM_PY tools/cala-eval/demix_stages.py report --name lookback-z3-vs-z0 --md <this file's stage sections>
$MINISIM_PY tools/cala-eval/demix_stages.py report --name lookback-z3-vs-z0 --ref z3:1     # cross-arm time to good
$MINISIM_PY tools/cala-eval/demix_report.py --base <z3 final stage> --new <z0 final stage>  # suite table, new rows excerpted below
```

## Sanity checks

- **Birth order points the expected way.** At the end of Discover, later-born cells have a 0.75-1 D bite share of 0.93-0.95 (z0 / z3) and earlier-born cells 0.45-0.57; at 0-0.5 D the earlier-born cell is never bitten (0/37, 0/49) while the later-born one is bitten in 0.87 / 0.53 of pairs (z3 / z0, final stage). The design note's "later-born cells today: about 0.9" is reproduced. At 25 % of Discover the later-born share is 1.000. A refine gate of 0 cuts the later-born share from 0.75 to 0.47 at 0.75-1 D at the final stage (`better`, 2/2 sims) and the earlier-born share from 0.43 to 0.24.
- **Late-born stratum is thin on these two sims** (15 / 9 cells, 12 / 5 pairs at 0.75-1 D); pairs_s5 has almost no late births. Most rows read `n/a` or very wide CIs. Use the full tier for it.
- **Undetected neighbours.** 5-11 % of matched-cell/undetected-neighbour pairs within 1 D are over-filled (est/true > 1.3); the median ratio is 1.00, so absorption is a minority event, not a shift. z3 over-fill rises across the stages (0.069, 0.082, 0.089, 0.106), CIs overlapping: more refinement does not reduce it here (the look-back Stage 2 criterion is <= 5 %).
- **Stages.** Everything improves monotonically and flattens by +2 Refine (headline z3 +0.208, +0.189, +0.180, +0.179; bite 0.75-1 D z3 0.796, 0.704, 0.647, 0.612). Time to good footprints against each arm's own +3 Refine: both reach it at +2 Refine (ratio 0.75). Against z3's Discover + 1 Refine (`--ref z3:1`): z0's Discover alone is already good (154 s vs 286 s, ratio 0.54), z3 reaches it at its own +1 Refine (ratio 1.00): the cross-arm form of the rule works.
- **Checkpoints.** Matched counts rise with the frame share (z3: 232, 268, 280, 295 per two sims) and the headline falls (+0.279 to +0.208): quality at 25 % of Discover is worse than at 100 % for headline and 0.5-1 D bite share, as it should be.
- **Fixed-library extraction reproduces the main dump closely but not exactly.** `pairs_s5` z0: scoring the main run's final `footprints.bin` through `qc_eval --library F --dump` gives trace correlation with the main run's own `dump_trace.f32` median 0.99995 (min 0.9925, max abs difference 2.0 on a trace peak of 86); the headline differs +0.122 (main dump) vs +0.138 (fixed library) on its 72 correlation pairs, bite share 0.75-1 D identical (0.263), leak median 0.032 vs 0.041. So every stage, including the last, is scored through the same extract path (`lib_footprints`); mixing the two would put a step of that size between the last stage and the others.
- **Cluster churn.** Share of cells in a cluster of 2+ grows 28 % to 59 % (z3) over Discover, max component 4 to 11. Between consecutive 1200-frame checkpoints 10-16 % of surviving cells (z3; 12-27 % for z0) change cluster; of the changes, regrouping of existing cells dominates after 50 % of the run (births dominate before). Cells that sit in a cluster see a membership change about every 2500-7000 frames (rate estimate): clusters are fairly stable on the scale of a few thousand frames, less so early on.
- Not verifiable here: the per-seed agreement flags (2 sims), the late-born stratum, time to good at finer than stage granularity.

Stages are what the app ends each step with (Discover, then each Refine). Checkpoints are the live library inside Discover. Pair metrics pooled over sims with a 95 % bootstrap CI over pairs (`demix_report.py` machinery); the reference for the difference table is the arm's last stage unless `--ref LABEL:K` names another arm's stage K (0 = Discover only). Definitions and the time-to-good rule: `demix_stages.py` docstring.

### Time to good footprints

Good = headline correlation excess and 0.75-1 D bite share both at or below the upper bound of the reference stage's 95 % CI. Cumulative wall = sum of the pass walls in `passes.tsv` (qc_eval pass loop).

| arm | reference    | first good stage | cumulative wall (s) | reference wall (s) | ratio |
| --- | ------------ | ---------------- | ------------------- | ------------------ | ----- |
| z0  | z0 +3 Refine | +2 Refine        | 455                 | 607                | 0.75  |
| z3  | z3 +3 Refine | +2 Refine        | 430                 | 575                | 0.75  |

### z0: stage comparison

Sims: pairs_s5, static_s5. Column header = stage and cumulative wall seconds.

| metric                                        | Discover (154 s)        | +1 Refine (305 s)       | +2 Refine (455 s)       | +3 Refine (607 s)       |
| --------------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- |
| corr excess < 1 D (headline)                  | +0.180 [+0.159, +0.203] | +0.160 [+0.139, +0.179] | +0.154 [+0.136, +0.172] | +0.154 [+0.134, +0.172] |
| corr excess 0.5-1 D                           | +0.158 [+0.142, +0.179] | +0.139 [+0.115, +0.159] | +0.134 [+0.116, +0.152] | +0.133 [+0.115, +0.151] |
| bite share 0-0.5 D                            | 0.479 [0.383, 0.574]    | 0.353 [0.265, 0.451]    | 0.275 [0.186, 0.363]    | 0.269 [0.183, 0.356]    |
| bite share 0.5-0.75 D                         | 0.490 [0.409, 0.570]    | 0.353 [0.275, 0.431]    | 0.288 [0.216, 0.366]    | 0.265 [0.199, 0.338]    |
| bite share 0.75-1 D                           | 0.713 [0.644, 0.782]    | 0.525 [0.454, 0.601]    | 0.418 [0.348, 0.489]    | 0.364 [0.299, 0.435]    |
| bite share 0.75-1 D, later-born               | 0.930 [0.859, 0.986]    | 0.689 [0.581, 0.797]    | 0.520 [0.413, 0.627]    | 0.467 [0.360, 0.573]    |
| bite share 0.75-1 D, earlier-born             | 0.446 [0.323, 0.569]    | 0.328 [0.209, 0.448]    | 0.313 [0.209, 0.433]    | 0.239 [0.134, 0.343]    |
| bite share 0.75-1 D, late-born (last 20 %)    | n/a                     | n/a                     | 0.600 [0.200, 1.000]    | 0.600 [0.200, 1.000]    |
| over-fill share at undetected neighbour < 1 D | 0.062 [0.018, 0.107]    | 0.085 [0.038, 0.142]    | 0.104 [0.047, 0.161]    | 0.085 [0.038, 0.142]    |
| leak share > 0.1 < 1 D                        | 0.374 [0.329, 0.420]    | 0.338 [0.295, 0.384]    | 0.321 [0.278, 0.364]    | 0.310 [0.267, 0.355]    |
| matched                                       | 302.0                   | 304.0                   | 304.5                   | 304.5                   |
| false                                         | 9.5                     | 7.5                     | 7.0                     | 7.0                     |
| cells matching 2+ GT units                    | 95.5                    | 103.0                   | 108.5                   | 111.5                   |
| pairs both matched 0.5-0.75 D                 | 37.5                    | 37.5                    | 37.5                    | 37.5                    |
| pairs both matched 0.75-1 D                   | 65.5                    | 68.0                    | 68.0                    | 68.0                    |

Difference from the reference (last stage, or `--ref`), 95 % CI, flag (`better`/`worse` need the CI to exclude 0 and 2/3 of the sims to agree):

| metric                                        | Discover (154 s)                     | +1 Refine (305 s)                    | +2 Refine (455 s)                    | +3 Refine (607 s)                    |
| --------------------------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------------ | ------------------------------------ |
| corr excess < 1 D (headline)                  | +0.026 [-0.002, +0.055] within noise | +0.006 [-0.021, +0.033] within noise | +0.000 [-0.025, +0.027] within noise | +0.000 [-0.026, +0.027] within noise |
| corr excess 0.5-1 D                           | +0.026 [+0.001, +0.054] worse        | +0.007 [-0.024, +0.035] within noise | +0.001 [-0.024, +0.028] within noise | +0.000 [-0.027, +0.026] within noise |
| bite share 0-0.5 D                            | +0.209 [0.077, 0.341] worse          | +0.084 [-0.043, 0.210] within noise  | +0.005 [-0.112, 0.123] within noise  | +0.000 [-0.115, 0.125] within noise  |
| bite share 0.5-0.75 D                         | +0.225 [0.118, 0.332] worse          | +0.088 [-0.017, 0.193] within noise  | +0.023 [-0.076, 0.127] within noise  | +0.000 [-0.099, 0.099] within noise  |
| bite share 0.75-1 D                           | +0.349 [0.252, 0.443] worse          | +0.160 [0.057, 0.264] worse          | +0.054 [-0.043, 0.152] within noise  | +0.000 [-0.098, 0.098] within noise  |
| bite share 0.75-1 D, later-born               | +0.463 [0.329, 0.585] worse          | +0.223 [0.062, 0.383] worse          | +0.053 [-0.107, 0.213] within noise  | +0.000 [-0.160, 0.160] within noise  |
| bite share 0.75-1 D, earlier-born             | +0.207 [0.054, 0.360] worse          | +0.090 [-0.060, 0.239] within noise  | +0.075 [-0.075, 0.224] within noise  | +0.000 [-0.149, 0.149] within noise  |
| bite share 0.75-1 D, late-born (last 20 %)    | n/a                                  | n/a                                  | +0.000 [-0.600, 0.600] within noise  | +0.000 [-0.600, 0.600] within noise  |
| over-fill share at undetected neighbour < 1 D | -0.022 [-0.095, 0.043] within noise  | +0.000 [-0.075, 0.075] within noise  | +0.019 [-0.057, 0.094] within noise  | +0.000 [-0.075, 0.075] within noise  |
| leak share > 0.1 < 1 D                        | +0.064 [0.001, 0.129] worse          | +0.028 [-0.033, 0.092] within noise  | +0.011 [-0.050, 0.073] within noise  | +0.000 [-0.062, 0.062] within noise  |

### z0: quality during Discover (live library at 25 / 50 / 75 / 100 % of the frames)

Cells not yet born are absent from early libraries, so matched counts rise and the undetected-neighbour row measures cells that come later.

| metric                                        | 25 % of Discover        | 50 % of Discover        | 75 % of Discover        | 100 % of Discover       |
| --------------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- |
| corr excess < 1 D (headline)                  | +0.253 [+0.218, +0.282] | +0.203 [+0.183, +0.229] | +0.191 [+0.164, +0.215] | +0.179 [+0.158, +0.200] |
| corr excess 0.5-1 D                           | +0.246 [+0.203, +0.278] | +0.193 [+0.174, +0.217] | +0.165 [+0.149, +0.196] | +0.158 [+0.142, +0.180] |
| bite share 0-0.5 D                            | 0.467 [0.300, 0.634]    | 0.460 [0.320, 0.600]    | 0.474 [0.355, 0.579]    | 0.489 [0.389, 0.589]    |
| bite share 0.5-0.75 D                         | 0.703 [0.595, 0.811]    | 0.566 [0.481, 0.651]    | 0.517 [0.434, 0.600]    | 0.490 [0.409, 0.570]    |
| bite share 0.75-1 D                           | 0.841 [0.756, 0.915]    | 0.769 [0.699, 0.832]    | 0.744 [0.679, 0.810]    | 0.713 [0.649, 0.776]    |
| bite share 0.75-1 D, later-born               | 1.000 [1.000, 1.000]    | 0.909 [0.818, 0.982]    | 0.925 [0.866, 0.985]    | 0.930 [0.873, 0.986]    |
| bite share 0.75-1 D, earlier-born             | 0.654 [0.462, 0.846]    | 0.529 [0.392, 0.667]    | 0.508 [0.381, 0.635]    | 0.446 [0.323, 0.569]    |
| bite share 0.75-1 D, late-born (last 20 %)    | n/a                     | n/a                     | n/a                     | n/a                     |
| over-fill share at undetected neighbour < 1 D | 0.048 [0.021, 0.080]    | 0.110 [0.062, 0.164]    | 0.051 [0.017, 0.093]    | 0.061 [0.026, 0.105]    |
| leak share > 0.1 < 1 D                        | 0.478 [0.403, 0.548]    | 0.404 [0.351, 0.457]    | 0.383 [0.334, 0.432]    | 0.373 [0.327, 0.421]    |
| matched                                       | 230.0                   | 274.0                   | 291.0                   | 301.5                   |
| false                                         | 10.5                    | 11.5                    | 10.5                    | 9.5                     |
| cells matching 2+ GT units                    | 63.5                    | 79.5                    | 89.0                    | 94.5                    |
| pairs both matched 0.5-0.75 D                 | 16.0                    | 31.5                    | 35.5                    | 37.5                    |
| pairs both matched 0.75-1 D                   | 34.5                    | 53.5                    | 61.0                    | 65.5                    |

Difference from the reference (last stage, or `--ref`), 95 % CI, flag (`better`/`worse` need the CI to exclude 0 and 2/3 of the sims to agree):

| metric                                        | 25 % of Discover                    | 50 % of Discover                    | 75 % of Discover                    | 100 % of Discover                    |
| --------------------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------ |
| corr excess < 1 D (headline)                  | +0.099 [+0.058, +0.135] worse       | +0.049 [+0.023, +0.081] worse       | +0.038 [+0.004, +0.067] worse       | +0.026 [-0.003, +0.053] within noise |
| corr excess 0.5-1 D                           | +0.113 [+0.068, +0.151] worse       | +0.061 [+0.033, +0.091] worse       | +0.032 [+0.008, +0.070] worse       | +0.026 [+0.001, +0.055] worse        |
| bite share 0-0.5 D                            | +0.197 [-0.008, 0.393] within noise | +0.191 [0.025, 0.350] worse         | +0.204 [0.060, 0.344] worse         | +0.220 [0.084, 0.354] worse          |
| bite share 0.5-0.75 D                         | +0.438 [0.316, 0.559] worse         | +0.301 [0.191, 0.414] worse         | +0.252 [0.144, 0.359] worse         | +0.225 [0.118, 0.332] worse          |
| bite share 0.75-1 D                           | +0.477 [0.369, 0.582] worse         | +0.405 [0.305, 0.501] worse         | +0.380 [0.284, 0.477] worse         | +0.349 [0.255, 0.443] worse          |
| bite share 0.75-1 D, later-born               | +0.533 [0.427, 0.640] worse         | +0.442 [0.299, 0.577] worse         | +0.459 [0.324, 0.587] worse         | +0.463 [0.330, 0.585] worse          |
| bite share 0.75-1 D, earlier-born             | +0.415 [0.193, 0.622] worse         | +0.291 [0.123, 0.463] worse         | +0.269 [0.103, 0.424] worse         | +0.207 [0.054, 0.373] worse          |
| bite share 0.75-1 D, late-born (last 20 %)    | n/a                                 | n/a                                 | n/a                                 | n/a                                  |
| over-fill share at undetected neighbour < 1 D | -0.037 [-0.099, 0.023] within noise | +0.025 [-0.048, 0.097] within noise | -0.034 [-0.106, 0.029] within noise | -0.024 [-0.092, 0.048] within noise  |
| leak share > 0.1 < 1 D                        | +0.169 [0.085, 0.252] worse         | +0.094 [0.026, 0.163] worse         | +0.073 [0.010, 0.137] worse         | +0.063 [0.000, 0.126] worse          |

### z3: stage comparison

Sims: pairs_s5, static_s5. Column header = stage and cumulative wall seconds.

| metric                                        | Discover (144 s)        | +1 Refine (286 s)       | +2 Refine (430 s)       | +3 Refine (575 s)       |
| --------------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- |
| corr excess < 1 D (headline)                  | +0.208 [+0.163, +0.233] | +0.189 [+0.163, +0.218] | +0.180 [+0.151, +0.210] | +0.179 [+0.152, +0.203] |
| corr excess 0.5-1 D                           | +0.187 [+0.152, +0.221] | +0.170 [+0.142, +0.194] | +0.167 [+0.136, +0.187] | +0.164 [+0.135, +0.185] |
| bite share 0-0.5 D                            | 0.472 [0.361, 0.597]    | 0.429 [0.321, 0.536]    | 0.429 [0.321, 0.536]    | 0.417 [0.310, 0.524]    |
| bite share 0.5-0.75 D                         | 0.600 [0.517, 0.683]    | 0.490 [0.408, 0.571]    | 0.455 [0.379, 0.538]    | 0.434 [0.359, 0.517]    |
| bite share 0.75-1 D                           | 0.796 [0.737, 0.856]    | 0.704 [0.633, 0.769]    | 0.647 [0.576, 0.718]    | 0.612 [0.535, 0.682]    |
| bite share 0.75-1 D, later-born               | 0.955 [0.896, 1.000]    | 0.838 [0.750, 0.926]    | 0.768 [0.667, 0.870]    | 0.754 [0.652, 0.855]    |
| bite share 0.75-1 D, earlier-born             | 0.569 [0.448, 0.690]    | 0.500 [0.362, 0.638]    | 0.466 [0.345, 0.586]    | 0.431 [0.310, 0.552]    |
| bite share 0.75-1 D, late-born (last 20 %)    | 1.000 [1.000, 1.000]    | 0.833 [0.583, 1.000]    | 0.833 [0.583, 1.000]    | 0.833 [0.583, 1.000]    |
| over-fill share at undetected neighbour < 1 D | 0.069 [0.031, 0.115]    | 0.082 [0.033, 0.131]    | 0.089 [0.041, 0.138]    | 0.106 [0.057, 0.163]    |
| leak share > 0.1 < 1 D                        | 0.424 [0.378, 0.474]    | 0.393 [0.345, 0.440]    | 0.381 [0.333, 0.429]    | 0.366 [0.318, 0.414]    |
| matched                                       | 295.0                   | 299.0                   | 299.0                   | 299.0                   |
| false                                         | 12.0                    | 8.0                     | 8.0                     | 8.0                     |
| cells matching 2+ GT units                    | 85.5                    | 93.0                    | 94.5                    | 97.0                    |
| pairs both matched 0.5-0.75 D                 | 36.0                    | 37.5                    | 37.0                    | 37.0                    |
| pairs both matched 0.75-1 D                   | 62.0                    | 63.5                    | 64.0                    | 64.0                    |

Difference from the reference (last stage, or `--ref`), 95 % CI, flag (`better`/`worse` need the CI to exclude 0 and 2/3 of the sims to agree):

| metric                                        | Discover (144 s)                                    | +1 Refine (286 s)                    | +2 Refine (430 s)                    | +3 Refine (575 s)                    |
| --------------------------------------------- | --------------------------------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------------ |
| corr excess < 1 D (headline)                  | +0.029 [-0.016, +0.068] within noise                | +0.010 [-0.025, +0.048] within noise | +0.001 [-0.034, +0.038] within noise | +0.000 [-0.035, +0.034] within noise |
| corr excess 0.5-1 D                           | +0.023 [-0.022, +0.067] within noise                | +0.007 [-0.029, +0.044] within noise | +0.003 [-0.036, +0.037] within noise | +0.000 [-0.035, +0.036] within noise |
| bite share 0-0.5 D                            | +0.056 [-0.103, 0.212] within noise                 | +0.012 [-0.143, 0.155] within noise  | +0.012 [-0.143, 0.167] within noise  | +0.000 [-0.155, 0.155] within noise  |
| bite share 0.5-0.75 D                         | +0.166 [0.048, 0.276] worse                         | +0.055 [-0.055, 0.171] within noise  | +0.021 [-0.090, 0.131] within noise  | +0.000 [-0.110, 0.110] within noise  |
| bite share 0.75-1 D                           | +0.185 [0.090, 0.280] worse                         | +0.092 [-0.008, 0.193] within noise  | +0.035 [-0.065, 0.135] within noise  | +0.000 [-0.100, 0.106] within noise  |
| bite share 0.75-1 D, later-born               | +0.202 [0.087, 0.318] within noise (seeds disagree) | +0.085 [-0.048, 0.216] within noise  | +0.014 [-0.130, 0.159] within noise  | +0.000 [-0.145, 0.145] within noise  |
| bite share 0.75-1 D, earlier-born             | +0.138 [-0.034, 0.310] within noise                 | +0.069 [-0.121, 0.259] within noise  | +0.034 [-0.138, 0.207] within noise  | +0.000 [-0.172, 0.172] within noise  |
| bite share 0.75-1 D, late-born (last 20 %)    | +0.167 [0.000, 0.417] within noise                  | +0.000 [-0.333, 0.250] within noise  | +0.000 [-0.333, 0.333] within noise  | +0.000 [-0.333, 0.333] within noise  |
| over-fill share at undetected neighbour < 1 D | -0.036 [-0.102, 0.034] within noise                 | -0.024 [-0.097, 0.050] within noise  | -0.016 [-0.089, 0.057] within noise  | +0.000 [-0.073, 0.073] within noise  |
| leak share > 0.1 < 1 D                        | +0.059 [-0.010, 0.127] within noise                 | +0.027 [-0.041, 0.097] within noise  | +0.015 [-0.055, 0.083] within noise  | +0.000 [-0.068, 0.068] within noise  |

### z3: quality during Discover (live library at 25 / 50 / 75 / 100 % of the frames)

Cells not yet born are absent from early libraries, so matched counts rise and the undetected-neighbour row measures cells that come later.

| metric                                        | 25 % of Discover        | 50 % of Discover        | 75 % of Discover        | 100 % of Discover       |
| --------------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- |
| corr excess < 1 D (headline)                  | +0.279 [+0.236, +0.305] | +0.259 [+0.231, +0.285] | +0.233 [+0.204, +0.271] | +0.208 [+0.163, +0.233] |
| corr excess 0.5-1 D                           | +0.267 [+0.225, +0.295] | +0.243 [+0.218, +0.277] | +0.228 [+0.184, +0.243] | +0.187 [+0.152, +0.221] |
| bite share 0-0.5 D                            | 0.500 [0.321, 0.679]    | 0.477 [0.341, 0.614]    | 0.480 [0.340, 0.620]    | 0.472 [0.361, 0.597]    |
| bite share 0.5-0.75 D                         | 0.811 [0.716, 0.892]    | 0.678 [0.591, 0.765]    | 0.651 [0.566, 0.736]    | 0.600 [0.517, 0.683]    |
| bite share 0.75-1 D                           | 0.895 [0.826, 0.953]    | 0.853 [0.790, 0.909]    | 0.816 [0.753, 0.873]    | 0.796 [0.737, 0.856]    |
| bite share 0.75-1 D, later-born               | 1.000 [1.000, 1.000]    | 0.962 [0.904, 1.000]    | 0.967 [0.917, 1.000]    | 0.955 [0.896, 1.000]    |
| bite share 0.75-1 D, earlier-born             | 0.759 [0.586, 0.897]    | 0.700 [0.580, 0.820]    | 0.614 [0.491, 0.737]    | 0.569 [0.448, 0.690]    |
| bite share 0.75-1 D, late-born (last 20 %)    | n/a                     | n/a                     | n/a                     | 1.000 [1.000, 1.000]    |
| over-fill share at undetected neighbour < 1 D | 0.043 [0.016, 0.076]    | 0.059 [0.026, 0.098]    | 0.063 [0.028, 0.105]    | 0.069 [0.031, 0.115]    |
| leak share > 0.1 < 1 D                        | 0.548 [0.479, 0.617]    | 0.500 [0.444, 0.556]    | 0.475 [0.421, 0.531]    | 0.424 [0.378, 0.474]    |
| matched                                       | 232.0                   | 267.5                   | 279.5                   | 295.0                   |
| false                                         | 7.5                     | 11.5                    | 12.0                    | 12.0                    |
| cells matching 2+ GT units                    | 60.0                    | 73.5                    | 78.5                    | 85.5                    |
| pairs both matched 0.5-0.75 D                 | 15.5                    | 27.5                    | 32.0                    | 36.0                    |
| pairs both matched 0.75-1 D                   | 32.5                    | 51.0                    | 55.0                    | 62.0                    |

Difference from the reference (last stage, or `--ref`), 95 % CI, flag (`better`/`worse` need the CI to exclude 0 and 2/3 of the sims to agree):

| metric                                        | 25 % of Discover                    | 50 % of Discover                                    | 75 % of Discover                                    | 100 % of Discover                                   |
| --------------------------------------------- | ----------------------------------- | --------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| corr excess < 1 D (headline)                  | +0.100 [+0.054, +0.140] worse       | +0.080 [+0.042, +0.121] worse                       | +0.054 [+0.018, +0.096] worse                       | +0.029 [-0.016, +0.068] within noise                |
| corr excess 0.5-1 D                           | +0.103 [+0.053, +0.143] worse       | +0.079 [+0.045, +0.122] worse                       | +0.065 [+0.013, +0.094] worse                       | +0.023 [-0.022, +0.067] within noise                |
| bite share 0-0.5 D                            | +0.083 [-0.131, 0.298] within noise | +0.061 [-0.121, 0.244] within noise                 | +0.063 [-0.112, 0.235] within noise                 | +0.056 [-0.103, 0.212] within noise                 |
| bite share 0.5-0.75 D                         | +0.376 [0.255, 0.493] worse         | +0.244 [0.127, 0.363] worse                         | +0.217 [0.099, 0.336] worse                         | +0.166 [0.048, 0.276] worse                         |
| bite share 0.75-1 D                           | +0.284 [0.184, 0.383] worse         | +0.241 [0.148, 0.333] worse                         | +0.205 [0.108, 0.301] worse                         | +0.185 [0.090, 0.280] worse                         |
| bite share 0.75-1 D, later-born               | +0.246 [0.145, 0.348] worse         | +0.208 [0.097, 0.319] within noise (seeds disagree) | +0.213 [0.103, 0.329] within noise (seeds disagree) | +0.202 [0.087, 0.318] within noise (seeds disagree) |
| bite share 0.75-1 D, earlier-born             | +0.328 [0.103, 0.534] worse         | +0.269 [0.088, 0.441] worse                         | +0.183 [-0.008, 0.357] within noise                 | +0.138 [-0.034, 0.310] within noise                 |
| bite share 0.75-1 D, late-born (last 20 %)    | n/a                                 | n/a                                                 | n/a                                                 | +0.167 [0.000, 0.417] within noise                  |
| over-fill share at undetected neighbour < 1 D | -0.062 [-0.127, -0.003] better      | -0.047 [-0.114, 0.018] within noise                 | -0.043 [-0.111, 0.022] within noise                 | -0.036 [-0.102, 0.034] within noise                 |
| leak share > 0.1 < 1 D                        | +0.182 [0.095, 0.266] worse         | +0.134 [0.061, 0.206] worse                         | +0.109 [0.037, 0.181] worse                         | +0.059 [-0.010, 0.127] within noise                 |

### Cluster membership during Discover (overlap clusters, rho >= 0.05, K_max 6)

From the library at each 12.5 % step of pass 1 (live library). `changed` = share of cells present at both checkpoints whose cluster member set differs; causes in order `birth` (a new cell joined), `loss` (a member was removed), `regroup` (same cells, other grouping). `frames between changes` = interval / share changed of cells that were in a cluster of 2+ (a rate estimate, not a median).

**z0** (sims pooled)

| checkpoint | interval (frames) | survivors | changed | birth / loss / regroup | clustered cells changed | frames between changes (clustered) | share in cluster 2+ | max component |
| ---------- | ----------------- | --------- | ------- | ---------------------- | ----------------------- | ---------------------------------- | ------------------- | ------------- |
| 25.0%      | 1200              | 367       | 21.3%   | 39 / 5 / 34            | 69.0%                   | 1738                               | 33.5%               | 6             |
| 37.5%      | 1200              | 475       | 26.5%   | 53 / 7 / 66            | 54.1%                   | 2219                               | 51.6%               | 8             |
| 50.0%      | 1200              | 537       | 23.6%   | 30 / 10 / 87           | 39.9%                   | 3005                               | 59.8%               | 8             |
| 62.5%      | 1200              | 566       | 17.1%   | 20 / 7 / 70            | 26.6%                   | 4503                               | 62.0%               | 11            |
| 75.0%      | 1200              | 584       | 15.8%   | 24 / 1 / 67            | 24.1%                   | 4970                               | 63.0%               | 12            |
| 87.5%      | 1200              | 597       | 11.6%   | 17 / 2 / 50            | 17.0%                   | 7043                               | 65.0%               | 12            |
| 100.0%     | 1200              | 607       | 14.0%   | 15 / 11 / 59           | 20.1%                   | 5972                               | 66.4%               | 12            |

**z3** (sims pooled)

| checkpoint | interval (frames) | survivors | changed | birth / loss / regroup | clustered cells changed | frames between changes (clustered) | share in cluster 2+ | max component |
| ---------- | ----------------- | --------- | ------- | ---------------------- | ----------------------- | ---------------------------------- | ------------------- | ------------- |
| 25.0%      | 1200              | 367       | 10.9%   | 30 / 0 / 10            | 46.0%                   | 2610                               | 28.0%               | 4             |
| 37.5%      | 1200              | 476       | 14.1%   | 37 / 2 / 28            | 40.4%                   | 2973                               | 41.3%               | 5             |
| 50.0%      | 1200              | 526       | 11.6%   | 22 / 5 / 34            | 26.9%                   | 4466                               | 47.8%               | 6             |
| 62.5%      | 1200              | 554       | 11.4%   | 20 / 3 / 40            | 23.9%                   | 5029                               | 50.3%               | 7             |
| 75.0%      | 1200              | 570       | 10.0%   | 12 / 7 / 38            | 19.2%                   | 6253                               | 53.8%               | 7             |
| 87.5%      | 1200              | 576       | 16.1%   | 23 / 8 / 62            | 28.3%                   | 4245                               | 56.9%               | 10            |
| 100.0%     | 1200              | 591       | 14.7%   | 20 / 6 / 61            | 24.3%                   | 4938                               | 59.3%               | 11            |

## Suite table excerpt (final stage, Discover + 3 Refines, z0 vs z3): the new rows

Full table: `demix_report.py` on the two final-stage libraries.

| metric | n pairs (z3 / z0) | z3 | z0 | diff [95 % CI] | seeds | flag |
| Bite share ratio < 0.5, later-born cell, 0.0-0.5 D | 37 / 49 | 0.865 [0.757, 0.973] (sd 0.009) | 0.531 [0.388, 0.673] (sd 0.118) | -0.334 [-0.511, -0.152] | 2/2 | **better** |
| Bite share ratio < 0.5, later-born cell, 0.5-0.75 D | 56 / 64 | 0.732 [0.607, 0.839] (sd 0.038) | 0.516 [0.391, 0.641] (sd 0.097) | -0.217 [-0.391, -0.042] | 2/2 | **better** |
| Bite share ratio < 0.5, later-born cell, 0.75-1.0 D | 69 / 75 | 0.754 [0.652, 0.855] (sd 0.188) | 0.467 [0.360, 0.587] (sd 0.101) | -0.287 [-0.437, -0.132] | 2/2 | **better** |
| leak_sd share > 0.1, later-born cell, < 1 D | 162 / 188 | 0.265 [0.198, 0.333] (sd 0.031) | 0.229 [0.170, 0.287] (sd 0.050) | -0.037 [-0.127, 0.052] | 2/2 | within noise |
| Bite share ratio < 0.5, earlier-born cell, 0.0-0.5 D | 37 / 49 | 0.000 [0.000, 0.000] (sd 0.000) | 0.000 [0.000, 0.000] (sd 0.000) | 0.000 [0.000, 0.000] | 0/2 | within noise |
| Bite share ratio < 0.5, earlier-born cell, 0.5-0.75 D | 57 / 65 | 0.175 [0.088, 0.281] (sd 0.054) | 0.062 [0.015, 0.123] (sd 0.051) | -0.114 [-0.228, 0.002] | 2/2 | within noise |
| Bite share ratio < 0.5, earlier-born cell, 0.75-1.0 D | 58 / 67 | 0.431 [0.310, 0.552] (sd 0.077) | 0.239 [0.134, 0.343] (sd 0.056) | -0.192 [-0.353, -0.027] | 2/2 | **better** |
| leak_sd share > 0.1, earlier-born cell, < 1 D | 152 / 181 | 0.454 [0.375, 0.533] (sd 0.052) | 0.403 [0.331, 0.475] (sd 0.030) | -0.051 [-0.159, 0.056] | 1/2 | within noise |
| Bite share ratio < 0.5, late-born cell, 0.0-0.5 D | 9 / 9 | 0.889 [0.667, 1.000] | 0.222 [0.000, 0.444] | -0.667 [-1.000, -0.333] | 1/1 | **better** |
| Bite share ratio < 0.5, late-born cell, 0.5-0.75 D | 6 / 3 | 0.833 [0.500, 1.000] | n/a | n/a | | n/a |
| Bite share ratio < 0.5, late-born cell, 0.75-1.0 D | 12 / 5 | 0.833 [0.583, 1.000] | 0.600 [0.200, 1.000] | -0.233 [-0.717, 0.217] | 1/1 | within noise |
| leak_sd share > 0.1, late-born cell, < 1 D | 27 / 17 | 0.296 [0.148, 0.481] | 0.235 [0.059, 0.471] | -0.061 [-0.327, 0.205] | 1/1 | within noise |
| Trace corr excess < 1 D, pairs with a late-born member | 28 / 20 | +0.137 [+0.074, +0.218] | +0.087 [+0.054, +0.199] | -0.050 [-0.144, +0.084] | 1/1 | within noise |
| Over-fill share est/true > 1.3 at undetected neighbour, 0.0-0.5 D | 53 / 45 | 0.038 [0.000, 0.094] | 0.022 [0.000, 0.067] | -0.016 [-0.075, 0.048] | 1/1 | within noise |
| Over-fill share est/true > 1.3 at undetected neighbour, 0.5-0.75 D | 35 / 33 | 0.114 [0.029, 0.229] | 0.152 [0.030, 0.273] | +0.037 [-0.113, 0.212] | 1/1 | within noise |
| Over-fill share est/true > 1.3 at undetected neighbour, 0.75-1.0 D | 35 / 28 | 0.200 [0.086, 0.343] | 0.107 [0.000, 0.250] | -0.093 [-0.271, 0.086] | 1/1 | within noise |
| Over-fill share est/true > 1.3 at undetected neighbour, < 1 D | 123 / 106 | 0.106 [0.057, 0.163] | 0.085 [0.038, 0.142] | -0.021 [-0.097, 0.052] | 1/1 | within noise |
| est/true at undetected neighbour's centre, median, < 1 D | 123 / 106 | 1.003 [0.959, 1.021] | 1.003 [0.957, 1.017] | +0.000 [-0.050, 0.046] | 0/1 | within noise |
| Late-born cells in the final library (born in the last 20 %) | 2 sims | 15.5 (sd 19.1) | 9.0 (sd 11.3) | -6.5 | | n/a |
| Late-born cells matched | 2 sims | 15.0 (sd 18.4) | 7.5 (sd 9.2) | -7.5 | | n/a |
| Cells in an overlap cluster of 2+ (rho >= 0.05, K_max 6) | 2 sims | 193.0 (sd 176.8) | 204.5 (sd 195.9) | +11.5 | | n/a |
| Largest overlap component (before the K_max cut) | 2 sims | 7.5 (sd 6.4) | 7.0 (sd 7.1) | -0.5 | | n/a |
Cluster = group of cells whose filtered footprints overlap (normalised Gram rho >= 0.05), cut to at most 6 members (design_joint_update.md 2.1). Size 1 = a cell with no overlapping neighbour (keeps the per-cell path).
| pairs_s5 | Trace corr excess < 1 D, pairs with a late-born member | n/a | n/a | n/a |
| static_s5 | Trace corr excess < 1 D, pairs with a late-born member | +0.149 | +0.094 | -0.055 |

## Overlap clusters of the final library (rho >= 0.05, greedy K_max 6; pooled over sims)

Cluster = group of cells whose filtered footprints overlap (normalised Gram rho >= 0.05), cut to at most 6 members (design_joint_update.md 2.1). Size 1 = a cell with no overlapping neighbour (keeps the per-cell path).

|                                     | z3        | z0        |
| ----------------------------------- | --------- | --------- |
| clusters of size 1                  | 228       | 214       |
| clusters of size 2                  | 85        | 85        |
| clusters of size 3                  | 25        | 25        |
| clusters of size 4                  | 10        | 16        |
| clusters of size 5                  | 13        | 8         |
| clusters of size 6                  | 6         | 10        |
| cells                               | 614       | 623       |
| cells in a cluster of 2+            | 386 (63%) | 409 (66%) |
| edges (rho >= 0.05) / cut by K_max  | 283 / 11  | 318 / 11  |
| cells whose component exceeds K_max | 49        | 70        |
| largest component (any sim)         | 12        | 12        |

## Cross-arm time to good footprints (reference z3 Discover + 1 Refine)

| arm | reference        | first good stage | cumulative wall (s) | reference wall (s) | ratio |
| --- | ---------------- | ---------------- | ------------------- | ------------------ | ----- |
| z0  | z3:1 (+1 Refine) | Discover         | 154                 | 286                | 0.54  |
| z3  | z3:1 (+1 Refine) | +1 Refine        | 286                 | 286                | 1.00  |
