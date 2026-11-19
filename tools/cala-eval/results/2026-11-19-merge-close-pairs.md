# Merge rule: duplicates vs real close pairs (19 Nov 2026)

Branch `fix/cala-merge-close-pairs`. Problem: with the cluster history replay in Discover
(`--passes 1 --joint-update all --joint-sign all`) about 9 matched cells per dense static sim are
lost vs main. Accurate footprints push real close pairs (centre distance ~0.35 D, GT cosine ~0.84)
past the 0.5 filtered-footprint overlap at which `merge()` skips both neighbour protections
(refitted-pair baseline, split-half shape gate). Applying both protections at every overlap
recovers 8 of 9 but adds ~3 false cells per sim (duplicates no longer merged), so overlap cannot
tell a duplicate from a real close pair (`fix/cala-discover-replay-loss`).

## Targets (written before any suite run)

Measured on the suite (`demix_suite.py`), pooled over sims with the suite's CIs:

1. **Discover-only replay** (`--passes 1 --joint-update all --joint-sign all`) with the new rule:
   matched cells within 1 % of main Discover-only (`--passes 1`), false cells within noise of main
   (no +3 per sim), final cells matching 2+ GT units and duplicates of a matched unit not above main.
2. **Main default** (Discover + Refine, `--passes 2 --later-passes refine`): the new rule is not
   worse than main without it on matched, false, 2+ GT units and the headline trace-corr excess.
3. **Motion** sims included (full tier): same criteria on the motion arm alone, since the 0.5
   shortcut was introduced for duplicates under motion.
4. No bias against newer cells: the share of lost later-born cells must not grow.

Offline (labelled set from `CALA_MERGE_LOG`, before any rule change): the chosen rule must keep
accepting nearly all duplicate merges (same GT unit) while rejecting the harmful close-pair merges
(the gone cell was the only cell on its unit), on held-out seeds and on motion.

## Labelled set (offline)

Run tree `$CALA_DATA/demix-suite/mp-labels2` (diagnostics build of this branch, full tier: static s5-s9, motion
s5-s9, pairs s5-s8; arms main = Discover + Refine, replay = `--passes 1 --joint-update all --joint-sign all`; both
with `--merge-log`). `merge_labels.py` turns every logged merge test at overlap >= 0.5 into a row labelled from the
cells' GT matches at test time and links each accepted merge to the removal it caused: **dup** = both cells on the
same GT unit (here also required: both at r >= 0.5), **harm** = two different units and the gone cell's unit is
unmatched at the end, **pairok** = two units but the gone unit is matched again later. `merge_saddle.py` adds a
single-peaked-union test; `merge_rules_eval.py` replays candidate rules over the accepted merges (a blocked merge
changes the later trajectory, so this is only a screen).

Caveats. The diagnostics build does not follow main's trajectory exactly (491 vs 501 matched on static_s5 in the
earlier diagnosis): the labels describe the diagnostics runs. The refitted-pair fields added to the log here are
observer-only (the work counter is restored; final.tsv byte-identical to the log build without them). Making the
merge log itself observer-only is a separate follow-up.

Accepted merges at overlap >= 0.5 (unique pairs, all seeds):

| arm / kind    | merges | harmful |
| ------------- | -----: | ------: |
| main static   |    130 |       9 |
| main motion   |    179 |       5 |
| main pairs    |     23 |       2 |
| replay static |    199 |      33 |
| replay motion |    234 |      29 |
| replay pairs  |     48 |      10 |

What does **not** separate duplicates from harmful close pairs (accepted merges, medians by class): held-out z, the
`one` clause (test-frame trace correlation), weaker/stronger energy share, drop-one losses, the refitted pair's energy
share or χ² (z against the refitted pair blocks 60-70 % of duplicate merges on motion), the earlier tests' history
(80 of 221 motion duplicates also had a test with z < -2 before), a single-peaked test on the union of the two
footprints (always single-peaked: 0.5 D apart is not resolvable as two peaks), and the split-half shape gate alone
(blocks harm 32/33 on motion but also 135/221 motion duplicates, which is the +3 false cells).

What separates: **how far apart the two cells' centres are**. Harmful close pairs sit 6-8 px apart (median 6.4 motion,
7.1 static; 10 % quantile 5.1-5.4), duplicates 3.6-4.5 px (90 % quantile 6.3-6.7); peaks of the PSF-smoothed
footprints and the logged centres give the same picture. With the split-half gate applied only to pairs whose centres
are >= 6 px (0.6 configured cell diameters) apart, still-merged out of merged now (train s5-s7 / test s8-s9 pooled):

Duplicate merges still accepted / all, harmful merges still accepted / all (want all duplicates, no harm):

| rule                                  | replay static |  replay motion | replay pairs | main static |  main motion | main pairs |
| ------------------------------------- | ------------: | -------------: | -----------: | ----------: | -----------: | ---------: |
| current                               |  65/65, 33/33 | 118/118, 29/29 | 13/13, 10/10 |  54/54, 9/9 | 111/111, 5/5 | 17/17, 2/2 |
| shape gate at every overlap           |   30/65, 1/33 |   38/118, 1/29 |   5/13, 1/10 |  33/54, 4/9 |  50/111, 0/5 |  8/17, 0/2 |
| centre >= 6 px veto                   |   52/65, 5/33 |   98/118, 6/29 |  11/13, 2/10 |  49/54, 3/9 |  98/111, 2/5 | 16/17, 2/2 |
| centre >= 6 px and shape > 0 (chosen) |   54/65, 5/33 |  100/118, 7/29 |  11/13, 3/10 |  52/54, 5/9 | 102/111, 2/5 | 16/17, 2/2 |

Held-out check (done on the footprint-peak version of the same rule, peaks > 0.4 measured D apart and shape > 0,
threshold read off s5-s7): on s8-s9 it blocks 12/13 harmful static and 10/15 harmful motion replay merges, and 5/26
and 10/44 duplicate merges, about the training rates. The Rust rule uses the cells' centres (logged `cy`, `cx`), which
separate as well as the peaks, with the threshold in configured cell diameters (`cell_diameter_px`, 10 px in these
runs; the GT half-max diameter is ~14.5 px).

## The rule (`SlowLoopConfig::merge_guard_min_sep`, `qc_eval --merge-guard-sep S`, default off)

A merge test whose two cells' centres are at least `S` cell diameters apart (`cell_diameter_px`) goes through the
split-half shape gate whatever the overlap of their footprints; pairs whose centres nearly coincide keep the
overlap shortcut (a duplicate or fragment of one soma). The refitted-pair baseline keeps its overlap bound (applying
it at every overlap blocked 60-70 % of motion duplicate merges offline). Evaluated at `S = 0.6` (6 px). Why centre
separation: overlap of two footprints grows as they become accurate (bites heal), so it moves with the replay; where
two somatic, single-peaked blobs sit does not. The gate itself is unchanged: two cells stay apart only when their
measured shapes differ beyond their own split-half noise. The test does not look at birth order or cell age.

Byte identity, flag off: `qc_eval` final.tsv, footprints.bin and removals.tsv identical to origin/main (7155c628) on
the smoke tier (static_s5, pairs_s5), which also covers the refactor of the refitted pair into `refit_pair`.

## Quick tier (static s5-s7, pairs s5-s6; 19 Nov 2026)

Run trees `$CALA_DATA/demix-suite/mp-quick-{replay,vsp1,replaybase,default}` (reports `.md` beside them).
`main` = origin/main 7155c628, `rule` = this branch with `--merge-guard-sep 0.6`. Replay = `--passes 1 --joint-update
all --joint-sign all`, p1 = `--passes 1`, default = Discover + Refine.

| comparison                         | matched                                   | false                          | headline corr excess      | 2+ GT cells   |
| ---------------------------------- | ----------------------------------------- | ------------------------------ | ------------------------- | ------------- |
| main p1 -> main replay (the loss)  | 346.8 -> 337.8, -9.0                      | 15.0 -> 14.6                   | +0.147 -> +0.104 (better) | +6.4 (worse)  |
| main replay -> rule replay         | 337.8 -> 343.8, +6.0 [-0.6, 12.6]         | 14.6 -> 15.2, +0.6 [-1.1, 2.3] | +0.104 -> +0.095 (noise)  | +7.2 (worse)  |
| main p1 -> rule replay (target 1)  | 346.8 -> 343.8, -3.0 (-0.9 %) [-8.6, 2.6] | 15.0 -> 15.2                   | +0.147 -> +0.095 (better) | +13.6 (worse) |
| main default -> rule default (t 2) | 349.0 -> 348.0, -1.0 [-4.7, 2.7]          | 12.8 -> 13.6, +0.8 [-0.2, 1.8] | +0.142 -> +0.145 (noise)  | -0.2 (noise)  |

Rule default: 0 of 61 metrics flagged. Rule replay vs main replay: close GT pairs 0.25-0.5 D both matched 17.8 ->
20.6 (better); 4 of 61 worse, 2+ GT cells among them.

The "2+ GT units" metric counts every cell with footprint r >= 0.5 to two units, which includes accurate cells of a
real close pair (GT cosine ~0.84, so each cell reaches its neighbour's unit). `multi_gt_split.py` splits it
(`mp-quick-multigt.md`, totals over the 5 sims):

| arm          | 2+ GT | resolved pair (both units matched by different cells) | blend | duplicates of a matched unit |
| ------------ | ----: | ----------------------------------------------------: | ----: | ---------------------------: |
| main p1      |   572 |                                                   340 |   232 |                           12 |
| main replay  |   604 |                                                   343 |   261 |                            8 |
| rule replay  |   640 |                                                   396 |   244 |                            9 |
| main default |   626 |                                                   389 |   237 |                           15 |
| rule default |   625 |                                                   396 |   229 |                           10 |

So the rule's extra 2+ GT cells are resolved close pairs (+53 vs main replay) and blends go down (-17); duplicates
of matched units do not rise (9 vs 12 main p1; 10 vs 15 main default).

Birth order (rule replay vs main replay): later-born bite share 0-0.5 D 0.593 -> 0.480, 0.5-0.75 D 0.511 -> 0.464
(within noise, same direction); leak share of later-born cells unchanged; default pipeline: late-born cells in the
library 8.8 -> 8.8, matched 6.4 -> 6.6.

## Full tier (static s5-s9, motion s5-s9, pairs s5-s8; 19 Nov 2026)

Run trees `$CALA_DATA/demix-suite/mp-full-{replay,vsp1,replaybase,default}`, multi-GT split in `mp-full-multigt.md`.

| comparison (mean per sim, [95 % CI])    | matched                                       | false                          | headline corr excess      |
| --------------------------------------- | --------------------------------------------- | ------------------------------ | ------------------------- |
| main p1 -> main replay (the loss)       | 396.8 -> 388.4, -8.4 [-12.2, -4.6]            | 25.2 -> 22.9, -2.3 [-6.3, 1.7] | +0.154 -> +0.110 (better) |
| main replay -> rule replay              | 388.4 -> 395.9, +7.5 [4.3, 10.7] (14/14 sims) | 22.9 -> 22.5, -0.4 [-3.5, 2.6] | +0.110 -> +0.108 (noise)  |
| main p1 -> rule replay (target 1)       | 396.8 -> 395.9, -0.9 (-0.2 %) [-3.3, 1.4]     | 25.2 -> 22.5, -2.7 [-5.8, 0.4] | +0.154 -> +0.108 (better) |
| main default -> rule default (target 2) | 400.1 -> 401.7, +1.6 [-0.6, 3.8]              | 21.9 -> 22.4, +0.6 [-1.9, 3.0] | +0.150 -> +0.151 (noise)  |

Rule default vs main default: 61 metrics, 2 better (slow-loop ms/frame), 1 worse (QC ms/frame +0.002, 0.5 %), the
rest within noise. By kind (mean per sim, matched / false):

| kind   | main replay -> rule replay    | main p1 -> rule replay        | main default -> rule default  |
| ------ | ----------------------------- | ----------------------------- | ----------------------------- |
| static | 496.6 -> 507.2 / 26.2 -> 24.8 | 509.6 -> 507.2 / 24.2 -> 24.8 | 512.6 -> 513.6 / 21.2 -> 21.0 |
| motion | 510.4 -> 519.0 / 35.0 -> 35.0 | 519.6 -> 519.0 / 42.6 -> 35.0 | 525.2 -> 528.6 / 37.0 -> 38.8 |
| pairs  | 100.5 -> 102.8 / 3.8 -> 4.0   | 102.2 -> 102.8 / 4.8 -> 4.0   | 103.2 -> 103.2 / 3.8 -> 3.8   |

2+ GT cells split (totals; resolved / blend / duplicates of a matched unit):

| kind   | main p1        | main replay    | rule replay    | main default   | rule default   |
| ------ | -------------- | -------------- | -------------- | -------------- | -------------- |
| static | 456 / 390 / 19 | 462 / 421 / 14 | 556 / 399 / 14 | 533 / 399 / 23 | 553 / 386 / 18 |
| motion | 495 / 425 / 87 | 537 / 472 / 61 | 599 / 444 / 64 | 587 / 429 / 91 | 597 / 435 / 94 |
| pairs  | 97 / 15 / 3    | 112 / 26 / 4   | 140 / 16 / 2   | 117 / 15 / 3   | 117 / 15 / 3   |

The suite's "2+ GT units" row is flagged worse for rule replay (+8.9 vs main replay); the split shows those are
resolved close pairs (+94 static, +62 motion, +28 pairs) while blends fall (-22, -28, -10).

**Birth order.** Rule replay vs main replay: late-born cells (born in the last 20 %) in the library 15.1 -> 10.6,
matched 11.8 -> 7.6. Against main p1 (12.2 / 8.2) rule replay is within noise (-1.6 [-3.8, 0.5], -0.6 [-2.1, 0.9]):
main replay's extra late-born cells are re-births of cells its wrong merges removed (a merge keeps the lower id, the
lost neighbour is found again later under a new id), which the rule no longer creates. Later-born bite shares move in
the better direction (within noise). The rule never looks at cell age.

## Verdict against the targets

1. Discover-only replay with the rule: matched -0.2 % vs main Discover-only (target within 1 %): **met**; false
   -2.7 (no +3): **met**; duplicates of matched units 14 / 64 / 2 vs 19 / 87 / 3 (main p1): **met**.
2. Main default with the rule: matched +1.6, false +0.6, headline +0.001, 2+ GT within noise: **met** (not worse).
3. Motion: replay +8.6 matched, false unchanged; default +3.4 matched, false +1.8 per sim (within noise, the largest
   move; duplicates of matched units 91 -> 94): **met**, watch.
4. Later-born cells: no loss vs main p1, fewer re-births vs main replay: **met**.

The rule stays behind `merge_guard_min_sep` (default off, byte-identical to main). The full tier supports switching
it on (0.6) with the replay in Discover; the default pipeline is neutral with it.

Follow-ups: make the merge log observer-only (the diagnostics build follows a slightly different trajectory);
the knob's 0.6 is read off the labelled set at `cell_diameter_px` 10 on sims whose GT half-max diameter is ~14.5 px
(0.4 GT diameters), so it should be checked on the v3 / size arms and real data, where the configured diameter may
match the cells better.
