# Neighbour-shadow ring floor (`--shadow-fill`): Off vs Min vs Median

16 Nov 2026. Code: feat/cala-shadow-fill on origin/main 20de18c (v2.19.1). Default `Off` (unchanged product behaviour).
Sims: designed isolated-pair sim seeds 5-8 (54 pairs/seed), dense static v2 s5, s7 (about 500 cells each). Stages
and metrics as in `measure/README.md` (discover = end of pass 1 with a frozen-library re-extraction; refine = after
`--passes 2 --later-passes refine`). Off = the v2.19.1 baseline in `runs_v2191/` (same binary behaviour as Off here,
same sims). Min and Median = `runs_shadow/`. One seed set, one run per cell: no confidence intervals; runs are
deterministic but sensitive to edit order, so a +-1 to 2 cell change in counts is noise.

How to read the tables. `ratio` = est/true of the peak-normalised footprint of cell i at neighbour j's centre (pairs with
true > 0.1 of peak); `ring` = the same ratio on the side opposite j (control, must not drop); `excess` = ratio - ring.
`leak_sd` = leak of j into i's trace in units of i's trace sd (`leak j to i`); the i to j columns are the reverse
orientation joined from the reverse row (report_crossorient method), the last column is leak i to j restricted to
bitten i (ratio < 0.5). "frac > 0.1" = fraction of ordered pairs with leak_sd > 0.1. Correlated-trace pairs are NOT
measured (the sims have independent traces; minisim has no trace-correlation knob).

## Headline

- Bite (0.5-0.75 D, refine): median ratio 0.51 -> 0.74 (Min) / 0.87 (Median) on pairs, 0.58 -> 0.74 / 0.87 on static;
  fraction bitten (< 0.5) 0.49 -> 0.28 / 0.15 (pairs), 0.44 -> 0.30 / 0.21 (static).
- Bite (0.75-1 D, refine): median ratio 0.11 -> 0.54 / 0.79 (pairs), 0.00 -> 0.55 / 0.72 (static); bitten fraction
  0.66 -> 0.46 / 0.25 (pairs), 0.62 -> 0.47 / 0.40 (static). Discover-stage static 0.75-1 D: median stays 0.00 for Min
  (0.01 Median) but the bitten fraction falls 0.75 -> 0.64 / 0.57.
- Control-side ring ratio does not drop in any bin (0.5-1 D: 0.90/0.75 off vs 0.92/0.75 Min vs 0.92/0.78 Median on
  static refine; pairs 0.96/0.89 vs 0.97/0.89 vs 0.97/0.88).
- Leak: median leak_sd (j to i) falls (pairs refine 0.5-0.75 D 0.059 -> 0.053 / 0.051, 0.75-1 D 0.045 -> 0.032 / 0.029;
  static refine 0.084 -> 0.073 / 0.059, 0.043 -> 0.041 / 0.035) and the fraction of pairs above 0.1 falls in both
  orientations (static refine 0.5-0.75 D 0.43 -> 0.40 / 0.32 for j to i, 0.42 -> 0.38 / 0.30 for i to j). The leak is
  not a simple function of the bite, so the gain is smaller than the footprint gain. Leak i to j of bitten cells:
  static 0.75-1 D 0.059 -> 0.048 / 0.056; at <0.5 D (peak inside the neighbour core, the fill is skipped there by
  design) nothing improves and Min is slightly worse in the bitten subgroup (0.230 -> 0.267, small n).
- No regression in detection on static s5, s7 (table below): false cells 15/22 -> 11/13 (Min), 12/16 (Median); matched
  cells 492/499 -> 497/500 (Min), 488/500 (Median); no duplicate cells on a GT cell in any arm; merge operations
  19/30 -> 22/31 (Min), 22/30 (Median); splits unchanged within +-2.
- Cost: QC cost per frame mean 0.342/0.344 ms (Off) -> 0.377/0.381 (Min), 0.342/0.368 (Median); pass wall 170/172 s ->
  177-205 s (Min). These timings were taken while another benchmark queue ran on the same machine, so they are an
  upper bound with +-10 % noise; treat as "about 5-10 % slower QC cost, not measured cleanly".
- Over-fill check: the lower-bound floor never created a footprint above truth that shows in the data: excess
  (ratio - ring) stays at or below 0 in every bin at 0.5-1 D for both arms.
- Not measured: the correlated-trace case; the fill-proposal acceptance rate through the refine gate (the qc_eval
  counter prints constructions that filled, not accepted proposals); headed Chrome with a real GPU.
- Recommendation: Min is the safe arm (lower bound by construction); Median gives larger gains here but over-fills
  elongated cells by design and is a benchmark arm only. Default stays Off for the PI decision.

Fill counters (qc_eval): static s5 Min 19209 constructions filled, 0.81 M pixels, mean mass added 1.6 %; Median
25254, 2.14 M px, 4.0 %. static s7 Min 18837 / 0.86 M / 2.0 %; Median 25444 / 2.33 M / 4.5 %.
pairs s5 Min 9795 / 0.41 M / 1.6 %; Median 12429 / 0.92 M / 3.5 %.

## Detection, dense static (pass 2 final library, final.tsv)

| sim | arm | cells | matched | false | dup (2nd cell on a GT) | GT detectable found / total | merge ops | splits | QC cost ms/frame |
|---|---|---|---|---|---|---|---|---|---|
| static_s5 | off | 507 | 492 | 15 | 0 | 492 / 605 | 19 | 7 | 0.342 |
| static_s5 | min | 508 | 497 | 11 | 0 | 497 / 605 | 22 | 7 | 0.377 |
| static_s5 | median | 500 | 488 | 12 | 0 | 488 / 605 | 22 | 9 | 0.342 |
| static_s7 | off | 521 | 499 | 22 | 0 | 499 / 609 | 30 | 9 | 0.344 |
| static_s7 | min | 513 | 500 | 13 | 0 | 500 / 609 | 31 | 9 | 0.381 |
| static_s7 | median | 516 | 500 | 16 | 0 | 500 / 609 | 30 | 7 | 0.368 |

## Bite and leak by distance bin

### pairs sims, discover

| arm | d (D) | n | med ratio | frac<0.5 | med ring (control) | med excess | med leak_sd (j to i) | frac leak_sd>0.1 | n x-orient | med leak i to j | frac i to j >0.1 | med leak i to j, bitten (ratio<0.5) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | <0.5 | 77 | 0.82 | 0.38 | 0.99 | -0.11 | 0.197 | 0.66 | 60 | 0.185 | 0.60 | 0.281 (n=29) |
| off | 0.5-0.75 | 90 | 0.40 | 0.53 | 0.93 | -0.35 | 0.074 | 0.34 | 86 | 0.077 | 0.35 | 0.087 (n=48) |
| off | 0.75-1 | 65 | 0.00 | 0.69 | 0.88 | -0.65 | 0.069 | 0.31 | 84 | 0.069 | 0.31 | 0.100 (n=45) |
| off | 1-1.25 | 19 | 0.00 | 0.84 | 0.43 | -0.27 | 0.025 | 0.10 | 58 | 0.027 | 0.10 | 0.076 (n=15) |
| min | <0.5 | 79 | 0.87 | 0.34 | 0.99 | -0.10 | 0.161 | 0.62 | 64 | 0.143 | 0.56 | 0.267 (n=27) |
| min | 0.5-0.75 | 90 | 0.70 | 0.38 | 0.94 | -0.20 | 0.064 | 0.36 | 86 | 0.065 | 0.37 | 0.114 (n=34) |
| min | 0.75-1 | 65 | 0.34 | 0.58 | 0.89 | -0.46 | 0.056 | 0.24 | 84 | 0.056 | 0.24 | 0.085 (n=38) |
| min | 1-1.25 | 20 | 0.00 | 0.80 | 0.45 | -0.18 | 0.024 | 0.08 | 60 | 0.024 | 0.08 | 0.066 (n=16) |
| median | <0.5 | 76 | 0.90 | 0.28 | 0.98 | -0.03 | 0.174 | 0.63 | 58 | 0.111 | 0.55 | 0.393 (n=21) |
| median | 0.5-0.75 | 89 | 0.85 | 0.24 | 0.94 | -0.08 | 0.063 | 0.31 | 84 | 0.064 | 0.32 | 0.089 (n=21) |
| median | 0.75-1 | 64 | 0.69 | 0.34 | 0.86 | -0.12 | 0.041 | 0.21 | 80 | 0.041 | 0.21 | 0.082 (n=22) |
| median | 1-1.25 | 19 | 0.00 | 0.68 | 0.47 | -0.14 | 0.020 | 0.05 | 58 | 0.021 | 0.05 | 0.038 (n=12) |

### pairs sims, refine

| arm | d (D) | n | med ratio | frac<0.5 | med ring (control) | med excess | med leak_sd (j to i) | frac leak_sd>0.1 | n x-orient | med leak i to j | frac i to j >0.1 | med leak i to j, bitten (ratio<0.5) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | <0.5 | 80 | 0.85 | 0.36 | 0.99 | -0.13 | 0.198 | 0.62 | 66 | 0.179 | 0.58 | 0.299 (n=29) |
| off | 0.5-0.75 | 91 | 0.51 | 0.49 | 0.96 | -0.42 | 0.059 | 0.35 | 88 | 0.060 | 0.36 | 0.096 (n=45) |
| off | 0.75-1 | 65 | 0.11 | 0.66 | 0.89 | -0.62 | 0.045 | 0.27 | 84 | 0.045 | 0.27 | 0.079 (n=43) |
| off | 1-1.25 | 19 | 0.00 | 0.74 | 0.61 | -0.26 | 0.014 | 0.08 | 58 | 0.015 | 0.09 | 0.058 (n=13) |
| min | <0.5 | 81 | 0.85 | 0.30 | 0.99 | -0.11 | 0.155 | 0.62 | 68 | 0.150 | 0.59 | 0.282 (n=24) |
| min | 0.5-0.75 | 90 | 0.74 | 0.28 | 0.97 | -0.17 | 0.053 | 0.31 | 86 | 0.053 | 0.33 | 0.081 (n=25) |
| min | 0.75-1 | 65 | 0.54 | 0.46 | 0.89 | -0.34 | 0.032 | 0.23 | 84 | 0.032 | 0.23 | 0.078 (n=30) |
| min | 1-1.25 | 20 | 0.00 | 0.75 | 0.56 | -0.26 | 0.014 | 0.08 | 60 | 0.014 | 0.08 | 0.076 (n=15) |
| median | <0.5 | 78 | 0.91 | 0.21 | 0.99 | -0.03 | 0.155 | 0.58 | 62 | 0.116 | 0.52 | 0.405 (n=16) |
| median | 0.5-0.75 | 89 | 0.87 | 0.15 | 0.97 | -0.08 | 0.051 | 0.22 | 84 | 0.048 | 0.23 | 0.090 (n=13) |
| median | 0.75-1 | 64 | 0.79 | 0.25 | 0.88 | -0.10 | 0.029 | 0.18 | 82 | 0.029 | 0.18 | 0.087 (n=16) |
| median | 1-1.25 | 19 | 0.00 | 0.63 | 0.54 | -0.12 | 0.013 | 0.07 | 58 | 0.014 | 0.07 | 0.051 (n=11) |

### static sims, discover

| arm | d (D) | n | med ratio | frac<0.5 | med ring (control) | med excess | med leak_sd (j to i) | frac leak_sd>0.1 | n x-orient | med leak i to j | frac i to j >0.1 | med leak i to j, bitten (ratio<0.5) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | <0.5 | 258 | 0.97 | 0.29 | 0.96 | 0.00 | 0.225 | 0.70 | 148 | 0.150 | 0.61 | 0.254 (n=67) |
| off | 0.5-0.75 | 336 | 0.42 | 0.54 | 0.83 | -0.24 | 0.098 | 0.48 | 266 | 0.098 | 0.48 | 0.124 (n=163) |
| off | 0.75-1 | 365 | 0.00 | 0.75 | 0.50 | -0.14 | 0.051 | 0.27 | 436 | 0.053 | 0.28 | 0.075 (n=221) |
| off | 1-1.25 | 103 | 0.00 | 0.82 | 0.02 | 0.00 | 0.027 | 0.11 | 508 | 0.029 | 0.12 | 0.070 (n=64) |
| min | <0.5 | 256 | 0.99 | 0.26 | 0.95 | 0.02 | 0.215 | 0.69 | 136 | 0.121 | 0.57 | 0.279 (n=59) |
| min | 0.5-0.75 | 336 | 0.59 | 0.45 | 0.83 | -0.11 | 0.100 | 0.50 | 260 | 0.099 | 0.49 | 0.126 (n=134) |
| min | 0.75-1 | 372 | 0.00 | 0.64 | 0.52 | -0.01 | 0.049 | 0.25 | 440 | 0.051 | 0.27 | 0.070 (n=199) |
| min | 1-1.25 | 105 | 0.00 | 0.84 | 0.04 | 0.00 | 0.026 | 0.11 | 534 | 0.028 | 0.12 | 0.065 (n=74) |
| median | <0.5 | 254 | 0.96 | 0.24 | 0.96 | 0.00 | 0.214 | 0.71 | 140 | 0.136 | 0.61 | 0.283 (n=53) |
| median | 0.5-0.75 | 339 | 0.75 | 0.35 | 0.85 | -0.02 | 0.083 | 0.42 | 264 | 0.081 | 0.40 | 0.135 (n=104) |
| median | 0.75-1 | 363 | 0.01 | 0.57 | 0.57 | 0.00 | 0.046 | 0.25 | 434 | 0.045 | 0.25 | 0.069 (n=168) |
| median | 1-1.25 | 104 | 0.00 | 0.80 | 0.12 | 0.00 | 0.025 | 0.09 | 506 | 0.027 | 0.10 | 0.059 (n=65) |

### static sims, refine

| arm | d (D) | n | med ratio | frac<0.5 | med ring (control) | med excess | med leak_sd (j to i) | frac leak_sd>0.1 | n x-orient | med leak i to j | frac i to j >0.1 | med leak i to j, bitten (ratio<0.5) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | <0.5 | 267 | 0.98 | 0.29 | 0.98 | 0.00 | 0.200 | 0.67 | 166 | 0.127 | 0.58 | 0.230 (n=72) |
| off | 0.5-0.75 | 343 | 0.58 | 0.44 | 0.90 | -0.25 | 0.084 | 0.43 | 276 | 0.082 | 0.42 | 0.116 (n=141) |
| off | 0.75-1 | 371 | 0.00 | 0.62 | 0.75 | -0.23 | 0.043 | 0.23 | 448 | 0.043 | 0.22 | 0.059 (n=193) |
| off | 1-1.25 | 105 | 0.00 | 0.76 | 0.23 | -0.02 | 0.022 | 0.08 | 524 | 0.023 | 0.08 | 0.059 (n=65) |
| min | <0.5 | 265 | 0.99 | 0.23 | 0.97 | 0.02 | 0.204 | 0.65 | 150 | 0.103 | 0.51 | 0.267 (n=54) |
| min | 0.5-0.75 | 341 | 0.74 | 0.30 | 0.92 | -0.15 | 0.073 | 0.40 | 274 | 0.071 | 0.38 | 0.114 (n=95) |
| min | 0.75-1 | 374 | 0.55 | 0.47 | 0.75 | -0.09 | 0.041 | 0.20 | 444 | 0.039 | 0.18 | 0.048 (n=151) |
| min | 1-1.25 | 108 | 0.00 | 0.79 | 0.22 | -0.03 | 0.021 | 0.08 | 548 | 0.022 | 0.09 | 0.047 (n=72) |
| median | <0.5 | 271 | 0.97 | 0.19 | 0.97 | 0.00 | 0.182 | 0.67 | 164 | 0.113 | 0.55 | 0.300 (n=48) |
| median | 0.5-0.75 | 353 | 0.87 | 0.21 | 0.92 | -0.03 | 0.059 | 0.32 | 284 | 0.058 | 0.30 | 0.100 (n=62) |
| median | 0.75-1 | 367 | 0.72 | 0.40 | 0.78 | -0.01 | 0.035 | 0.18 | 440 | 0.033 | 0.16 | 0.056 (n=119) |
| median | 1-1.25 | 109 | 0.00 | 0.64 | 0.31 | 0.00 | 0.021 | 0.07 | 524 | 0.021 | 0.07 | 0.037 (n=55) |

