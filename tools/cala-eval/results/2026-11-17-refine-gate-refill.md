# Refine gate: accept any held-out gain (`refine_z` 3 → 0)

17 Nov 2026. Branch `fix/cala-refine-gate-refill`. Measurements were made with an experiment binary
(`exp/cala-oracle-refine`, `--features diagnostics`, `qc_eval --refine-z Z`). The PR's own `qc_eval` at the new default
reproduces it byte for byte: pairs s5, `footprints_pass1.bin` and `footprints.bin` are identical to the z 0 run. Run
directories and scripts are in `~/Projects/cala-data/demix-bench/measure/` (`runs_gate/`, `analyze_gate.py`,
`stability_gate.py`, `real_compare.py`). They are not in the repo.

## The change

`SlowLoopConfig::refine_z` defaults to 0 instead of 3. Two things are unchanged:

- It applies to statistics-path refinements only. Reservoir-path refinements still need `absorb_z`.
- A statistics-path proposal must still pass the split-half test first (`RefineGate::SplitHalf`, Î > 0 over all
  fitting frames).

A proposal is then kept when its paired held-out χ² gain is positive. Before, it also needed a paired z > 3 on the tile's
few dozen held-out frames.

**Why.** The root cause is a footprint bite: a later-born neighbour is born without the light under the older cell's
centre, and Discover never refills it. The 3σ veto on the held-out frames is what locks that bite in (measure report
`report_discover_bites.md`). The bite and the trace leak that comes with it are the PI's demixing complaint.

The change adds no constant, no penalty and no size constraint. `qc_eval --refine-z Z` keeps the old behaviour available
for comparison (`--refine-z 3`).

**Scope.** It acts in Discover and in Refine. Discover's pass-1 library changes too: static s5 pass 1 goes from 507 cells /
483 matched to 518 / 500.

## Choice of z

The sweep below covered z 3 / 2 / 1 / 0.5 / 0. It does not separate z ≤ 1:

|                             | z 1     | z 0     |
| --------------------------- | ------- | ------- |
| Static 0.75-1 D bite median | 0.37    | 0.51    |
| Motion 0.75-1 D bite median | 0.45    | 0.10    |
| Real data, Minian matches   | 506     | 502     |
| Motion false cells          | 39      | 44      |
| Static false cells          | 16 / 26 | 15 / 20 |

z 0 was chosen for two reasons. It is the parameter-free rule (any held-out gain). It is also the arm with the full set
of checks: 5-pass stability, motion and real data. z 1 has no 5-pass stability run.

## Sweep: static s5 + s7 and pairs s5-8 (Discover + 1 Refine pass)

**Bite and leak** (Refine stage). ratio = peak-normalised estimated A_i(c_j) / truth for GT neighbours i, j; ring is the
away-side control.

| set    | z     | d (D)    | n   | ratio med | ring med | frac ratio < 0.5 | leak_sd med | frac leak_sd > 0.1 |
| ------ | ----- | -------- | --- | --------- | -------- | ---------------- | ----------- | ------------------ |
| static | 3     | 0.5-0.75 | 274 | 0.49      | 0.91     | 0.51             | 0.082       | 0.42               |
| static | 1     | 0.5-0.75 | 286 | 0.65      | 0.95     | 0.37             | 0.060       | 0.36               |
| static | **0** | 0.5-0.75 | 292 | **0.68**  | 0.95     | **0.36**         | **0.057**   | **0.35**           |
| static | 3     | 0.75-1   | 291 | 0.00      | 0.76     | 0.66             | 0.047       | 0.25               |
| static | 1     | 0.75-1   | 330 | 0.37      | 0.83     | 0.52             | 0.035       | 0.22               |
| static | **0** | 0.75-1   | 315 | **0.51**  | 0.83     | **0.50**         | **0.037**   | **0.23**           |
| pairs  | 3     | 0.5-0.75 | 88  | 0.47      | 0.96     | 0.51             | 0.060       | 0.36               |
| pairs  | **0** | 0.5-0.75 | 86  | **0.69**  | 0.98     | **0.28**         | 0.056       | 0.36               |
| pairs  | 3     | 0.75-1   | 65  | 0.11      | 0.89     | 0.66             | 0.050       | 0.29               |
| pairs  | **0** | 0.75-1   | 65  | **0.61**  | 0.91     | **0.40**         | **0.030**   | **0.18**           |

The < 0.5 D leak also falls: static 0.127 → 0.105, pairs 0.179 → 0.136.

**Trace correlation excess.** hp 15 s; median r of matched pairs at < 1 D minus the median at 1.5-3 D.

| set    | z 3    | z 2    | z 1    | z 0.5  | z 0        |
| ------ | ------ | ------ | ------ | ------ | ---------- |
| static | +0.166 | +0.152 | +0.144 | +0.137 | **+0.137** |
| pairs  | +0.224 | +0.204 | +0.194 | +0.184 | **+0.178** |

**Detection, area, cost and acceptance.** Areas are medians. Acceptance is for statistics-path refine tests in passes ≥ 2.

| sim        | z   | cells | matched | false | merges / splits | area px (support / half-max) | QC ms/frame | refine acceptance |
| ---------- | --- | ----- | ------- | ----- | --------------- | ---------------------------- | ----------- | ----------------- |
| static_s5  | 3   | 507   | 492     | 15    | 19 / 7          | 558 / 145                    | 0.357       | 7.2 %             |
| static_s5  | 1   | 518   | 502     | 16    | 24 / 8          | 589 / 148                    | 0.385       | 24.8 %            |
| static_s5  | 0   | 519   | 504     | 15    | 31 / 7          | 596 / 147                    | 0.331       | 37.5 %            |
| static_s7  | 3   | 521   | 499     | 22    | 30 / 9          | 565 / 147                    | 0.366       | 8.0 %             |
| static_s7  | 1   | 537   | 511     | 26    | 32 / 10         | 589 / 151                    | 0.381       | 26.6 %            |
| static_s7  | 0   | 532   | 512     | 20    | 38 / 14         | 599 / 152                    | 0.357       | 38.1 %            |
| pairs s5-8 | 3   | 432   | 412     | 20    |                 |                              | 0.184-0.192 | 0.8-1.5 %         |
| pairs s5-8 | 0   | 428   | 413     | 15    |                 |                              | 0.177-0.185 | 17.7-21.8 %       |

Two things to note:

- Cost per frame is unchanged within machine noise, and so is the wall time per pass.
- z 0.5 and z 2 lie in between: static s5 matched 498 and 503, false 18 and 14. Full tables are in
  `runs_gate/sweep_tables.md`.

## Motion (motion_s5, Discover + 1 Refine pass)

| z     | 0.5-0.75 D ratio / leak_sd | 0.75-1 D ratio / frac < 0.5 / leak_sd | corr excess < 1 D | cells | matched | false | merges / splits | area px   | QC ms/f |
| ----- | -------------------------- | ------------------------------------- | ----------------- | ----- | ------- | ----- | --------------- | --------- | ------- |
| 3     | 0.46 / 0.083               | 0.00 / 0.63 / 0.064                   | +0.209            | 530   | 495     | 35    | 25 / 6          | 542 / 146 | 0.395   |
| 1     | 0.72 / 0.078               | 0.45 / 0.51 / 0.037                   | +0.160            | 557   | 518     | 39    | 49 / 15         | 576 / 149 | 0.351   |
| **0** | **0.71 / 0.077**           | 0.10 / 0.53 / **0.042**               | **+0.169**        | 557   | **513** | 44    | 45 / 14         | 581 / 150 | 0.413   |

At z 0, motion gains 18 matched cells and 9 false cells. Merges and splits rise (25 → 45 and 6 → 14).

## Stability over repeated Refine passes (Discover + 4 Refine passes)

These are the per-pass changes:

- "acc. refines" are accepted statistics-path refines in that pass, with refills in brackets.
- corr to prev is the footprint corr to the previous pass, by id: median / fraction of cells < 0.99.
- Area is the median support.

| sim       | z   | pass | acc. refines | corr to prev med / frac < 0.99 | area px | med abs area change | r to GT med / p10 |
| --------- | --- | ---- | ------------ | ------------------------------ | ------- | ------------------- | ----------------- |
| static_s5 | 3   | 2    | 1732 (593)   | 0.9937 / 0.438                 | 558     | 0.095               | 0.9840 / 0.888    |
| static_s5 | 3   | 5    | 1448 (340)   | 1.0000 / 0.039                 | 605     | 0.000               | 0.9876 / 0.913    |
| static_s5 | 0   | 2    | 8015 (2650)  | 0.9916 / 0.458                 | 596     | 0.175               | 0.9889 / 0.924    |
| static_s5 | 0   | 3    | 8978 (2934)  | 0.9988 / 0.108                 | 614     | 0.027               | 0.9901 / 0.936    |
| static_s5 | 0   | 5    | 8697 (2565)  | 0.9994 / 0.017                 | 628     | 0.014               | 0.9916 / 0.944    |
| pairs_s5  | 3   | 5    | 54 (12)      | 1.0000 / 0.037                 | 646     | 0.000               | 0.9916 / 0.928    |
| pairs_s5  | 0   | 5    | 2543 (297)   | 0.9995 / 0.000                 | 666     | 0.011               | 0.9946 / 0.977    |
| pairs_s6  | 3   | 5    | 122 (15)     | 1.0000 / 0.056                 | 633     | 0.000               | 0.9920 / 0.934    |
| pairs_s6  | 0   | 5    | 2775 (365)   | 0.9996 / 0.009                 | 670     | 0.011               | 0.9938 / 0.926    |

**Isolated cells** (no other GT unit within 1.25 D), r to GT med / p10 at pass 5:

| sim       | n     | z 3            | z 0            |
| --------- | ----- | -------------- | -------------- |
| static_s5 | 91-93 | 0.9915 / 0.919 | 0.9935 / 0.965 |
| pairs_s5  | 26    | 0.9937 / 0.986 | 0.9959 / 0.993 |
| pairs_s6  | 22    | 0.9933 / 0.987 | 0.9953 / 0.992 |

**Reading.**

- **Refines don't die out in count.** At z 0, accepted refines stay at 5-6× the z 3 rate: about 17 per cell per pass on
  static.
- **But each refine changes less and less.** By pass 5 the share of cells moving by more than corr 0.99 is 1.7 %, against
  3.9 % at z 3. No footprint oscillates.
- **Accuracy keeps rising.** Corr to GT is higher at z 0 at every pass, for isolated cells too, and still rising at pass 5.
- **Support area grows at a slowing rate**, as it does at z 3 (z 3 +2 %/pass, z 0 +1 %/pass by pass 5). It has not
  reached a plateau by pass 5 at either z.

**Unit test.** A 6-cell toy, `refine_only_passes_keep_supports_bounded`:

- the largest support goes 165 → 178-185 px over 10 passes at z 0 (z 3: 179 from pass 1);
- the test now asserts growth ≤ 15 % over pass 1 and a spread ≤ 5 % over passes 5-7.

## Real data (workshop CA1, 18000 frames, motion + flat field, Discover + 1 Refine pass)

Minian is a reference, not ground truth: these are agreement numbers. Every run is scored at the same Minian offset
(1, 0) and the same D (10.52 px).

| run     | cells | median area support / half-max | Minian matched (r ≥ 0.7) | matched fp r med | all-pair hp corr excess < 0.75 / 0.75-1 / 1-1.5 D | matched-pair excess 0.75-1 D, cala vs Minian | fp value at neighbour centre (< 1 D) |
| ------- | ----- | ------------------------------ | ------------------------ | ---------------- | ------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| z 3     | 830   | 333 / 87                       | 510                      | 0.947            | +0.148 / +0.127 / +0.092                          | +0.138 vs +0.245                             | 0.185                                |
| z 1     | 831   | 381 / 92                       | 506                      | 0.947            | +0.131 / +0.107 / +0.077                          | +0.113 vs +0.227                             | 0.215                                |
| **z 0** | 823   | 387 / 93                       | 502                      | 0.949            | +0.134 / +0.109 / +0.083                          | +0.116 vs +0.226                             | 0.218                                |

**Cell count and Minian agreement.** The cell count is unchanged, and Minian agreement is within 2 %. Close-pair
correlation excess falls by 10-15 %.

**Where the support grows.** Median support grows 16 %, but half-max area grows only 7 %. For cells matched by centre
(z 3 → z 0):

- the median added mass is 4 % of the footprint (p90 15 %), at about 0.1 of peak;
- 82 % of the added mass lies inside another cell's support, and 42 % inside another cell's half-max core.

So the growth is mostly the neighbour-side refill, not free-floating tails. On static s5 the same numbers are 1.6 % added
mass, 65 % in another support.

**Pair 14/306** (auto3_s1 ids, about 1.1 D) is unchanged at every z: 0.0 / 0.0 at the neighbour centres, hp corr 0.12. The
fix does not reach it.

## Not measured

- Headed Chrome on a real GPU, which the PI still needs to check. Look at Refine memory and time with 5-6× more accepted
  refines.
- Correlated-trace sims.
- v3 sims.
- More than one seed for motion and for real data.
- z 1 5-pass stability.
- z 0 combined with shadow fill (PR #412).
