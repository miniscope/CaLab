# Demixing evaluation: z0 vs z3 (quick tier)

Validation of `demix_suite.py` (17 Nov 2026): the refine gate `--refine-z 3` against `--refine-z 0` on the quick tier,
one binary (origin/main 898b6e7). Command:

```
$MINISIM_PY tools/cala-eval/demix_suite.py --tier quick --bin <qc_eval from 898b6e7> \
    --base-label z3 --new-label z0 --base-flags "--refine-z 3" --new-flags "--refine-z 0" --name quick-z3-vs-z0
```

Wall time 33.8 min (10 runs, 2 at a time, about 1 GB each, plus metrics). Reproduces the known direction: bite share and
leak fall at z 0, the headline trace-correlation excess falls (+0.170 to +0.142; the refine-gate note had +0.166 to +0.137 on
static, +0.224 to +0.178 on pairs), the 0.75-1 D median ratio goes 0.00 to 0.50. Merge edits and two-GT cells rise at z 0 as
before (+5 and +15 per 5 sims) but with 5 sims this is `within noise`; the full tier (14 sims, with motion) is the place to
resolve it. `static_s5` z 0 footprints are byte-identical to the experiment binary's run, so the suite is deterministic.

- tier: quick
- sims: ['static_s5', 'static_s6', 'static_s7', 'pairs_s5', 'pairs_s6']
- run root: /Users/daharoni/Projects/cala-data/demix-suite/quick-z3-vs-z0
- qc_eval args: --passes 2 --later-passes refine --batch 8 --budget 30000000 --slow-seed 1 --dump
- z3: `x` flags ``
- z0: `x` flags ``
- wall minutes: 0

Sims (5): pairs_s5, pairs_s6, static_s5, static_s6, static_s7. Baseline = `z3`, candidate = `z0`.

**Headline** (trace correlation excess < 1 D, lower is better): +0.170 -> +0.142, diff -0.028 [-0.049, -0.008]: **better**. Across all 24 metrics: 9 better, 0 worse, 2 changed (no direction), 13 within noise.

Pair metrics: pooled over sims, `[..]` = 95 % bootstrap CI over pairs, `sd` = spread of the per-sim values. Run metrics: mean over sims, `sd` across sims. Diff CI: bootstrap (pair metrics) or paired t over sims (run metrics, needs >= 3). Flag: the CI excludes 0 and >= 2/3 of the sims agree in sign; `seeds` = sims that moved the same way as the pooled difference.

| metric                                                            | n pairs (z3 / z0) | z3                                  | z0                                  | diff [95 % CI]             | seeds | flag         |
| ----------------------------------------------------------------- | ----------------- | ----------------------------------- | ----------------------------------- | -------------------------- | ----- | ------------ |
| **Trace corr excess < 1 D (15 s high-pass; vs 1.5-3 D) HEADLINE** | 710 / 754         | +0.170 [+0.153, +0.184] (sd +0.036) | +0.142 [+0.130, +0.153] (sd +0.032) | -0.028 [-0.049, -0.008]    | 5/5   | **better**   |
| Trace corr excess 0.5-1 D                                         | 584 / 619         | +0.150 [+0.135, +0.162] (sd +0.008) | +0.121 [+0.107, +0.135] (sd +0.018) | -0.028 [-0.047, -0.009]    | 4/5   | **better**   |
| Bite share ratio < 0.5, 0.0-0.5 D                                 | 252 / 270         | 0.421 [0.361, 0.480] (sd 0.024)     | 0.378 [0.319, 0.433] (sd 0.054)     | -0.043 [-0.127, 0.039]     | 4/5   | within noise |
| Bite share ratio < 0.5, 0.5-0.75 D                                | 471 / 511         | 0.512 [0.465, 0.556] (sd 0.037)     | 0.352 [0.311, 0.393] (sd 0.079)     | -0.159 [-0.220, -0.096]    | 5/5   | **better**   |
| Bite share ratio < 0.5, 0.75-1.0 D                                | 470 / 498         | 0.668 [0.628, 0.711] (sd 0.063)     | 0.498 [0.454, 0.542] (sd 0.041)     | -0.170 [-0.230, -0.109]    | 5/5   | **better**   |
| Bite ratio median, 0.0-0.5 D (secondary)                          | 252 / 270         | 0.684 [0.509, 0.797] (sd 0.050)     | 0.688 [0.575, 0.891] (sd 0.127)     | +0.004 [-0.175, 0.268]     | 3/5   | within noise |
| Bite ratio median, 0.5-0.75 D (secondary)                         | 471 / 511         | 0.489 [0.412, 0.570] (sd 0.081)     | 0.684 [0.629, 0.739] (sd 0.045)     | +0.195 [0.094, 0.287]      | 5/5   | **better**   |
| Bite ratio median, 0.75-1.0 D (secondary)                         | 470 / 498         | 0.000 [0.000, 0.000] (sd 0.000)     | 0.503 [0.411, 0.579] (sd 0.051)     | +0.503 [0.410, 0.579]      | 5/5   | **better**   |
| Control ring ratio median, < 1 D                                  | 1193 / 1279       | 0.911 [0.900, 0.922] (sd 0.033)     | 0.948 [0.940, 0.954] (sd 0.017)     | +0.037 [0.023, 0.050]      | 5/5   | changed      |
| leak_sd median, < 1 D                                             | 1193 / 1279       | 0.0677 [0.0601, 0.0735] (sd 0.0052) | 0.0541 [0.0499, 0.0610] (sd 0.0116) | -0.0136 [-0.0210, -0.0036] | 5/5   | **better**   |
| leak_sd share > 0.1, < 1 D                                        | 1193 / 1279       | 0.394 [0.366, 0.422] (sd 0.024)     | 0.342 [0.317, 0.369] (sd 0.053)     | -0.052 [-0.090, -0.014]    | 4/5   | **better**   |
| Matched cells                                                     | 5 sims            | 339.8 (sd 216.7)                    | 349.0 (sd 224.7)                    | +9.2 [-1.4, 19.8]          | 4/5   | within noise |
| False cells                                                       | 5 sims            | 12.8 (sd 8.0)                       | 12.8 (sd 9.0)                       | 0.0 [-3.4, 3.4]            | 2/5   | within noise |
| Net (matched - false)                                             | 5 sims            | 327.0 (sd 209.1)                    | 336.2 (sd 216.1)                    | +9.2 [0.2, 18.2]           | 4/5   | **better**   |
| Final cells matching 2+ GT units (footprint r >= 0.5)             | 5 sims            | 110.4 (sd 74.5)                     | 125.4 (sd 86.0)                     | +15.0 [-0.6, 30.6]         | 5/5   | within noise |
| Close GT pairs, both matched, 0-0.25 D                            | 5 sims            | 1.6 (sd 1.9)                        | 1.4 (sd 0.9)                        | -0.2 [-3.0, 2.6]           | 1/5   | within noise |
| Close GT pairs, both matched, 0.25-0.5 D                          | 5 sims            | 20.8 (sd 14.1)                      | 23.8 (sd 15.7)                      | +3.0 [-1.6, 7.6]           | 3/5   | within noise |
| Close GT pairs, both matched, 0.5-0.75 D                          | 5 sims            | 47.4 (sd 34.2)                      | 51.4 (sd 38.6)                      | +4.0 [-3.0, 11.0]          | 2/5   | within noise |
| Close GT pairs, both matched, 0.75-1 D                            | 5 sims            | 69.6 (sd 52.7)                      | 73.8 (sd 56.7)                      | +4.2 [-1.1, 9.5]           | 3/5   | within noise |
| Merge edits (about 2/3 harmless folds; see two-GT cells)          | 5 sims            | 17.6 (sd 9.8)                       | 22.6 (sd 13.6)                      | +5.0 [-1.7, 11.7]          | 4/5   | within noise |
| Splits                                                            | 5 sims            | 5.0 (sd 2.9)                        | 4.6 (sd 5.9)                        | -0.4 [-4.6, 3.8]           | 3/5   | within noise |
| Median support area (px)                                          | 5 sims            | 592 (sd 36)                         | 616 (sd 23)                         | +23 [4, 43]                | 4/5   | changed      |
| Median half-max area (px)                                         | 5 sims            | 148 (sd 2)                          | 150 (sd 3)                          | +2 [-3, 6]                 | 4/5   | within noise |
| QC ms/frame                                                       | 5 sims            | 0.298 (sd 0.108)                    | 0.306 (sd 0.114)                    | +0.008 [-0.000, 0.017]     | 5/5   | within noise |

## Close-pair resolution (GT neuron pairs pooled over sims; matched in the final library: both / one / neither)

| distance   | z3         | z0         |
| ---------- | ---------- | ---------- |
| 0.0-0.25 D | 8/72/9     | 7/77/5     |
| 0.25-0.5 D | 104/103/17 | 119/95/10  |
| 0.5-0.75 D | 237/117/27 | 257/102/22 |
| 0.75-1.0 D | 348/139/26 | 369/114/30 |

## Per sim

| sim       | metric                                               | z3     | z0     | diff   |
| --------- | ---------------------------------------------------- | ------ | ------ | ------ |
| pairs_s5  | Trace corr excess < 1 D (15 s high-pass; vs 1.5-3 D) | +0.186 | +0.131 | -0.055 |
| pairs_s6  | Trace corr excess < 1 D (15 s high-pass; vs 1.5-3 D) | +0.248 | +0.207 | -0.041 |
| static_s5 | Trace corr excess < 1 D (15 s high-pass; vs 1.5-3 D) | +0.159 | +0.142 | -0.017 |
| static_s6 | Trace corr excess < 1 D (15 s high-pass; vs 1.5-3 D) | +0.171 | +0.135 | -0.035 |
| static_s7 | Trace corr excess < 1 D (15 s high-pass; vs 1.5-3 D) | +0.165 | +0.132 | -0.033 |
| pairs_s5  | Bite share ratio < 0.5, 0.75-1.0 D                   | 0.789  | 0.526  | -0.263 |
| pairs_s6  | Bite share ratio < 0.5, 0.75-1.0 D                   | 0.643  | 0.429  | -0.214 |
| static_s5 | Bite share ratio < 0.5, 0.75-1.0 D                   | 0.693  | 0.524  | -0.169 |
| static_s6 | Bite share ratio < 0.5, 0.75-1.0 D                   | 0.664  | 0.500  | -0.164 |
| static_s7 | Bite share ratio < 0.5, 0.75-1.0 D                   | 0.631  | 0.470  | -0.161 |
| pairs_s5  | Matched cells                                        | 103.0  | 103.0  | 0.0    |
| pairs_s6  | Matched cells                                        | 102.0  | 103.0  | +1.0   |
| static_s5 | Matched cells                                        | 492.0  | 504.0  | +12.0  |
| static_s6 | Matched cells                                        | 503.0  | 523.0  | +20.0  |
| static_s7 | Matched cells                                        | 499.0  | 512.0  | +13.0  |
| pairs_s5  | False cells                                          | 4.0    | 1.0    | -3.0   |
| pairs_s6  | False cells                                          | 5.0    | 6.0    | +1.0   |
| static_s5 | False cells                                          | 15.0   | 15.0   | 0.0    |
| static_s6 | False cells                                          | 18.0   | 22.0   | +4.0   |
| static_s7 | False cells                                          | 22.0   | 20.0   | -2.0   |
| pairs_s5  | Splits                                               | 3.0    | 1.0    | -2.0   |
| pairs_s6  | Splits                                               | 2.0    | 1.0    | -1.0   |
| static_s5 | Splits                                               | 7.0    | 7.0    | 0.0    |
| static_s6 | Splits                                               | 4.0    | 0.0    | -4.0   |
| static_s7 | Splits                                               | 9.0    | 14.0   | +5.0   |
| pairs_s5  | QC ms/frame                                          | 0.180  | 0.181  | +0.001 |
| pairs_s6  | QC ms/frame                                          | 0.181  | 0.183  | +0.002 |
| static_s5 | QC ms/frame                                          | 0.402  | 0.414  | +0.012 |
| static_s6 | QC ms/frame                                          | 0.364  | 0.382  | +0.018 |
| static_s7 | QC ms/frame                                          | 0.361  | 0.370  | +0.009 |
