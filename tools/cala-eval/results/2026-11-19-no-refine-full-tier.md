# Discover without Refine, full tier (19 Nov 2026)

Targets written 19 Nov 2026 before any run (commit order shows it). Results go below them.

## Question

Does the combined "Discover without Refine" configuration (look-back inside Discover from #427, the cluster replay,
and the merge rule from #429) match main Discover + 1 Refine on the full demix suite, at less compute?

## Arms (one binary, main f14efd8c, full tier: static s5-s9, motion s5-s9, pairs s5-s8)

- `DR-main`: main default, Discover + 1 Refine (`--passes 2 --later-passes refine`, the suite default).
- `COMBO`: `--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --merge-guard-sep 0.6`
  (no Refine pass).

## Targets (COMBO vs DR-main; paired suite rules, CIs from the suite)

Evaluated for all sims pooled and for the motion sims alone.

1. Footprint r with GT, median, in every footprint group (all matched cells, isolated, close-pair): within 0.003 of
   `DR-main` (COMBO minus DR-main >= -0.003).
2. Share of cells with footprint r < 0.9: within noise of `DR-main` (CI of the difference includes 0, or better).
3. Crosstalk (trace corr excess < 1 D, the headline) and bites (bite share ratio < 0.5, all bins): better than
   `DR-main` (CI of the difference favours COMBO).
4. Matched cells: within 1 % of `DR-main`.
5. False cells: within noise of `DR-main`.
6. Compute: lower total compute than `DR-main` (pass-loop wall summed over sims, including the look-back's own wall).

Also reported: birth-time rows (first half, second half, last 20 %), whether the look-back settles (cells still in
need at the end of Discover and after the drain, `lookback.tsv`), and the fast-loop per-frame cost.

## Results (full tier, 14 sims, binary main f14efd8c; run tree `$CALA_DATA/demix-suite/combo-full`)

### In plain language

Discover with look-back, the replay and the merge rule, and no Refine pass, matches Discover + 1 Refine on footprint
quality and beats it on crosstalk, bites and false cells. Its one footprint loss is isolated cells (-0.0023, inside
the 0.003 allowance). The compute saving is real on static and pairs sims (about 13 % and 24 % less pass-loop wall)
but absent on motion (+2 %), so the combined saving is about 8 %. Late-born cells are no longer clearly worse, but
the sample is too small to say they are equal.

### Targets, judged (diff = COMBO - DR-main, 95 % CI; all 14 sims | motion alone, 5 sims)

| #   | target                                        | all sims                                                                                               | motion alone                                                             | verdict                                                         |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 1   | footprint r, all, within 0.003                | 0.9879 -> 0.9899, +0.0019 [0.0013, 0.0025]                                                             | 0.9866 -> 0.9886, +0.0020 [0.0011, 0.0031]                               | met                                                             |
| 1   | footprint r, isolated                         | 0.9922 -> 0.9899, -0.0023 [-0.0033, -0.0008]                                                           | 0.9915 -> 0.9895, -0.0020 [-0.0046, -0.0005]                             | met (inside 0.003; CI excludes 0, suite flags it worse)         |
| 1   | footprint r, close-pair                       | 0.9843 -> 0.9895, +0.0052 [0.0042, 0.0061]                                                             | 0.9825 -> 0.9877, +0.0052 [0.0039, 0.0070]                               | met                                                             |
| 2   | r < 0.9 share, all / isolated / close         | 0.056 -> 0.052 (-0.004 [-0.012, 0.004]); isolated +0.002 [-0.020, 0.024]; close -0.011 [-0.022, 0.000] | 0.066 -> 0.060 (-0.006); isolated -0.011; close -0.010; all within noise | met                                                             |
| 3   | crosstalk, headline corr excess < 1 D         | +0.150 -> +0.086, -0.064 [-0.074, -0.054], 14/14 sims                                                  | +0.160 -> +0.101, -0.058 [-0.077, -0.046], 5/5                           | met                                                             |
| 3   | bite share < 0.5, 0-0.5 / 0.5-0.75 / 0.75-1 D | 0.382 -> 0.201; 0.353 -> 0.180; 0.486 -> 0.283 (all CIs below 0)                                       | 0.399 -> 0.217; 0.350 -> 0.180; 0.469 -> 0.284 (all CIs below 0)         | met                                                             |
| 4   | matched cells within 1 %                      | 400.1 -> 400.9, +0.8 [-1.7, 3.3] (+0.2 %)                                                              | 525.2 -> 524.2, -1.0 [-5.2, 3.2] (-0.2 %)                                | met                                                             |
| 5   | false cells within noise                      | 21.9 -> 18.1, -3.8 [-6.3, -1.3]                                                                        | 37.0 -> 29.6, -7.4 [-10.1, -4.7]                                         | met (fewer false cells; net +4.6 [0.9, 8.2] / +6.4 [0.8, 12.0]) |
| 6   | lower total compute                           | pass-loop wall 5308 s -> 4887 s (-8 %)                                                                 | 2534 s -> 2588 s (+2 %)                                                  | met for all sims, missed for motion                             |

### Birth-time rows (suite rows; n is small for late births, so these are underpowered)

| row                                      | DR-main | COMBO  | diff [95 % CI]            |
| ---------------------------------------- | ------- | ------ | ------------------------- |
| footprint r, born first half             | 0.9895  | 0.9909 | +0.0015 [0.0010, 0.0019]  |
| footprint r, born second half            | 0.9560  | 0.9575 | +0.0015 [-0.0046, 0.0088] |
| footprint r, born last 20 %              | 0.9306  | 0.9235 | -0.0071 [-0.0274, 0.0115] |
| r < 0.9 share, second half               | 0.189   | 0.219  | +0.029 [-0.021, 0.081]    |
| r < 0.9 share, last 20 %                 | 0.323   | 0.385  | +0.062 [-0.059, 0.183]    |
| bite share < 0.5, later-born, 0-0.5 D    | 0.744   | 0.391  | -0.353 [-0.424, -0.282]   |
| bite share < 0.5, later-born, 0.5-0.75 D | 0.638   | 0.292  | -0.346 [-0.396, -0.294]   |
| bite share < 0.5, later-born, 0.75-1 D   | 0.691   | 0.376  | -0.314 [-0.364, -0.264]   |
| late-born cells in final library         | 12.2    | 10.2   | -2.0 [-4.7, 0.7] per sim  |
| late-born cells matched                  | 9.5     | 7.8    | -1.7 [-4.3, 0.9] per sim  |

Motion alone: second half 0.9505 -> 0.9572 (+0.0067 [-0.0044, 0.0149]), last 20 % 0.9307 -> 0.9226 (-0.0081
[-0.0301, 0.0263]), later-born bite share improves by 0.28-0.35, same as all sims. The late-born footprint rows are
within noise but the point estimates for the last 20 % and the r < 0.9 share lean worse; with 109-133 cells per arm the
CI cannot rule out a loss of 0.03 in r, so late-born footprints are "not shown different", not "shown equal".

### Does look-back settle?

Yes. In all 14 sims the cells still needing look-back frames (`in_need`) is 0 at the end. The drain after the last
Discover frame ran 1 to 2771 steps (cap 4800), never hitting the cap. Look-back frames per sim: 18.0k-24.4k (323k in
all, about 2 per Discover frame); the look-back's own wall is 1951 s of the 4887 s total (static 117-121 s per
sim, motion 216-228 s, pairs 50-71 s).

### Compute

| group  | DR-main pass-loop wall (s) | COMBO pass-loop wall (s, includes look-back) |
| ------ | -------------------------- | -------------------------------------------- |
| static | 1767                       | 1535 (-13 %)                                 |
| motion | 2534                       | 2588 (+2 %)                                  |
| pairs  | 1007                       | 764 (-24 %)                                  |
| total  | 5308                       | 4887 (-8 %)                                  |

Wall is noisy: 6 runs at once. Deterministic and per-frame numbers: slow-loop work units per frame in the last pass
are 36.6 M (DR-main, which is its Refine pass) vs 46.0 M (COMBO, its only pass, +9.3 M [6.9, 11.7] M); this is a
per-pass figure, not a total, so it does not give the total saving. Slow-loop step wall per frame 10.0 -> 11.3 ms.
Fast loop: QC ms/frame 0.386 -> 0.367 (-0.019, better). Cluster stores peak 26.9 MB; peak RSS 0.90 -> 0.99 GB
(+0.09). The compute target is therefore met in aggregate only through static and pairs; motion shows no saving, since
motion look-back frames are re-warped and Refine is a smaller share there.

### "Final cells matching 2+ GT units" (+18.1 all, +24.4 motion, flagged worse)

`multi_gt_split.py` on this run (totals over 14 sims; resolved close pairs / blends / duplicates of a matched unit):

| arm     | 2+ GT | resolved | blend | dup of matched |
| ------- | ----: | -------: | ----: | -------------: |
| DR-main |  2080 |     1237 |   843 |            117 |
| COMBO   |  2333 |     1468 |   865 |             78 |

Of the +253, +231 are resolved close pairs (both units matched by different cells), blends +22 (about 0.4 per sim),
duplicates of matched units fall by 39. So the flag is mostly accurate footprints of real close pairs reaching their
neighbour's unit, as in the merge-rule study, and not a quality loss.

### Verdict

Targets 1 to 5 met for all sims and for motion alone. Target 6 met for all sims (-8 %, noisy) and missed for motion
(+2 %). Open: isolated footprints stay 0.002 below DR-main (inside the allowance), and late-born footprints are
underpowered here.
