# E2: ground-truth-free held-out score, validation (11 Nov 2026)

Binary: this branch at 7bb1914 (base, `--core-test trim`, `--slow-seed 2`) and
cc6cc0e (base only, for `rho_Sf_TP`; the two differ only in how `S_frac` is
computed). Sims: `static` and `motion`, seeds 5-9, `--batch 8 --budget
30000000 --slow-seed 1`. Real runs: 7bb1914 or cc6cc0e (same scores).

## Verdict

| test (plan / brief)                                 | result                                                        | pass |
| --------------------------------------------------- | ------------------------------------------------------------- | ---- |
| per-cell AUC of `ho_marginal_z`, TP vs not, >= 0.80 | 0.878 static, 0.888 motion (per seed 0.83-0.91); pooled 0.885 | yes  |
| Spearman(S, TP) over checkpoints >= 0.9             | 0.54 static, 0.58 motion (S); 0.59 / 0.60 (S_frac)            | no   |
| S ranks base above `--core-test trim` on motion     | d(S8) = -21 +- 360, signs 2/3 (P8 -0.014, 5/5 seeds)          | no   |
| `--slow-seed` null pairs do not separate            | d(S8) covers 0 on both arms                                   | yes  |

## Why S fails, and the proposed fixes (not implemented)

1. **S is blind to false positives by construction.** The penalty is the mean
   gain of a placebo column, so a non-cell nets 0 on average: S rewards true
   cells and ignores the rest. `trim` adds 8.6 FPs (5/5 seeds) and changes TPs
   by -1.4; S moves by -21 +- 360. Charging two placebo gains per cell
   (`S2 = G - 2 k mu`, AIC-like) does not help (d = +33 +- 299): one FP costs
   about 1 unit per frame, one TP is worth about 70, and library-to-library
   variation is hundreds.
   Fix: measure precision with the per-cell score instead. The share of cells
   with `ho_marginal_z > 2` (threshold fixed before these runs) falls by
   0.016 +- 0.010 with `trim` on motion (0/5 seeds up), and the count of
   cells at or below z = 2 rises by 10.0 +- 7.0 (5/5) for 8.6 extra FPs; the
   null pairs cover 0 (static +4.6 +- 6.6, motion +13.8 +- 17.4). A candidate
   GT-free precision axis; it needs its own pre-declared test before it is
   used for a claim.
2. **S per checkpoint window tracks activity, not the library.** Each window
   scores different frames; after frame ~2000 the TP count rises ~15 % while
   the window-to-window spread of G is ~20 %. Dividing by the held-out light
   (`S_frac`) does not fix it (rho 0.59-0.60). Fix: score libraries on the same
   frames. Keep the checkpoint libraries and run them with `--library` over
   a common tail segment that none of them was fitted on (the fixed-library
   mode in this PR does this), or re-score a fixed bank of held-out frames
   with each version.

## Per-seed numbers (runs2)

| arm    | seed | TP base/trim/null | S8 base/trim/null     | AUC_S base/trim/null  |
| ------ | ---- | ----------------- | --------------------- | --------------------- |
| static | 5    | 476 / 467 / 470   | 21604 / 21377 / 20147 | 19015 / 19075 / 19175 |
| static | 6    | 480 / 482 / 493   | 26065 / 25876 / 25534 | 23078 / 23135 / 23003 |
| static | 7    | 474 / 475 / 475   | 30406 / 30746 / 30384 | 26162 / 26236 / 25930 |
| static | 8    | 475 / 480 / 483   | 20291 / 19852 / 20787 | 19895 / 19828 / 20528 |
| static | 9    | 483 / 487 / 480   | 22755 / 22337 / 23819 | 22545 / 22626 / 22690 |
| motion | 5    | 465 / 476 / 480   | 42729 / 42707 / 41458 | 34001 / 33982 / 34169 |
| motion | 6    | 478 / 475 / 489   | 35419 / 35096 / 33876 | 27780 / 27664 / 28684 |
| motion | 7    | 478 / 469 / 483   | 29609 / 29740 / 29852 | 30717 / 30730 / 30524 |
| motion | 8    | 485 / 485 / 490   | 24086 / 24464 / 24502 | 25435 / 25487 / 25646 |
| motion | 9    | 505 / 499 / 512   | 42298 / 42028 / 43202 | 28439 / 28396 / 28894 |

S is in units of s² per held-out frame (the gain of a placebo column is about
0.5-2 per frame).

## Real data (workshop recording, 18 000 frames, `--motion`)

Slow-loop run from an empty library: S over all held-out frames 10 219 (gain
11 511, placebo penalty 1 291 = 11 %), last window 11 898; 676 cells.
`ho_marginal_z` of the final library (656 scored of 677): quantiles 5 %
-0.5, 25 % 1.1, median 4.4, 75 % 15.1, 95 % 73.5; histogram `<-2` 13, `-2..0`
62, `0..2` 141, `2..5` 138, `5..10` 80, `10..20` 104, `20..50` 73, `>50` 45.

Fixed libraries on the same held-out frames (`--library`): S = 13 268 (r9),
13 309 (r1), 13 403 (r2g), 12 119 (Minian, its 708 units).

Agreement with the PI's labels (299 candidates; each scored in its source
library; PI labels are a reference, not ground truth): AUC of
`ho_marginal_z`, cell vs not, 0.916 (143 / 54); on quickly-decided labels
(below the median 3.7 s) 0.947; cala candidates 0.956 (121 / 46), Minian-only
0.574 (22 / 8). Found-by-N-runs on the same cala candidates: 0.698. Within
cells found by one run only, z still separates cell from not at 0.945.
Unsure vs not 0.782, cell vs unsure 0.769.

## Cost

Share of qc_eval wall time inside the score: 9.0-13.6 % over the 40 sim runs
(overhead 10-16 % over a run without it), 13.0 % on the real slow-loop run.
The fixed-library mode has no slow loop, so the score is 17-27 % of a much
shorter run there. Stages (real slow-loop run, s): gain 3.9, cell drop-one
16.9, placebo library builds 42.8, placebo solve 9.0, placebo gains 11.8.
`--no-heldout` gives identical libraries (checked on static s5, 3000 frames).
