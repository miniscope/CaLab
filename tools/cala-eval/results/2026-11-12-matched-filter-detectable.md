# minisim 1.1.0: `detectable` becomes a matched-filter SNR (12 Nov 2026)

minisim 1.1.0 (PR miniscope/minisim#36, approved by the PI) replaces the `detectable` test. The old test was a single-pixel, single-transient peak SNR >= 3. The new one is a matched-filter SNR >= 110 over each cell's realized footprint and all its transients:

`SNR^2 = sum_i g_i^2 a_i^2 / sigma_i^2 * sum_t Delta_t^2`

- `g` is the per-pixel gain (vessels, illumination, vignette, exposure, QE).
- `a` is the realized footprint, after defocus, scatter and halo.
- `Delta_t = (C_t - min C) * B_t` is the transient above rest, with bleaching `B`.
- `sigma_i^2` is shot noise on all the light at the pixel plus read noise.

The old test undercounted on the v3 sims (`2026-11-12-sim-v3-scales.md`): cala matched 116 GT units on `v3_static_s5` that were not flagged detectable. The sims were not regenerated. Only the flag in their ground truth was rewritten (`tools/minisim-calibration/recompute_detectable.py`), because the videos do not depend on it at a fixed focal depth.

## Threshold

Recovery means a final cala cell matches the GT unit (qc_eval, r >= 0.7, Hungarian matching). The 50 % point comes from a logistic fit in log SNR. Per-unit tables come from `recovery_vs_snr.py`. qc_eval was `81f041c` (sanity runs: `8a086ae`) with `--batch 8 --budget 30000000 --slow-seed 1`, at 480 s and 600 px.

| arm (cell size)                   | runs                  | GT units scored    | SNR at 50 % recovery | AUC       |
| --------------------------------- | --------------------- | ------------------ | -------------------- | --------- |
| size6_static (6 px): **fit**      | s5, s6                | 1527               | **111 (CI 104-117)** | 0.92      |
| v3_static (10 px): validation     | s5                    | 767                | 103                  | 0.79      |
| size16_static (16 px)             | s5                    | 775                | 368                  | 0.79      |
| v2 static / motion / halo (14 px) | e6 x1 base, s5-9 each | 3083 / 3236 / 3242 | 426 / 436 / 356      | 0.83-0.87 |

`DETECT_SNR_THRESHOLD = 110` was fitted on 6 px cells and holds without retuning on 10 px cells. Two arms need 3-4 times more SNR: v2 (14 px, wide scatter blur) and size16. Neither is used for the fit. Three things point to cala's size prior (`DEFAULT_CELL_DIAMETER_PX` = 10, unchanged in qc_eval), not to noise:

- These arms' cells are larger than that 10 px setting.
- Their isolated cells (no other unit within 20 px) show the same shift (v2 static: 314).
- qc_eval's own measured peak SNR shifts the same way: its 50 % point is 1.9 on v2 and 0.56 on v3.

Using 50 % on v2 (~430) would have flagged most of the cells cala recovers on v3 as non-detectable.

Fraction recovered by matched-filter SNR (number of GT units in brackets):

| arm                | 50-75     | 75-110    | 110-150    | 150-200    | 200-300    | 300-450    | 450-700    | 700-1000   | >1000       |
| ------------------ | --------- | --------- | ---------- | ---------- | ---------- | ---------- | ---------- | ---------- | ----------- |
| size6 static (fit) | 0.03 (36) | 0.29 (68) | 0.66 (122) | 0.88 (154) | 0.94 (269) | 0.97 (318) | 0.99 (301) | 0.99 (162) | 1.00 (79)   |
| v3 static (10 px)  | -         | 0.00 (5)  | 0.53 (15)  | 0.74 (35)  | 0.87 (70)  | 0.92 (129) | 0.94 (161) | 0.95 (141) | 0.99 (211)  |
| size16 static      | 0.00 (1)  | 0.00 (2)  | 0.00 (2)   | 0.09 (11)  | 0.26 (27)  | 0.62 (56)  | 0.72 (135) | 0.79 (136) | 0.92 (405)  |
| v2 static (s5-9)   | 0.00 (6)  | 0.00 (5)  | 0.00 (26)  | 0.06 (53)  | 0.20 (133) | 0.41 (266) | 0.71 (483) | 0.81 (577) | 0.93 (1534) |
| v2 motion (s5-9)   | 0.00 (9)  | 0.00 (15) | 0.07 (29)  | 0.02 (56)  | 0.19 (190) | 0.43 (314) | 0.67 (527) | 0.81 (584) | 0.93 (1500) |

## Before and after on `static_s5`

The same cala output was scored twice (identical cells: 486 on v2, 722 on v3), with the 1.0.3 flags and then with the 1.1.0 flags. GT detectable counts are given over all units (oracle.bin) and over the units qc_eval scores (`gt.tsv`).

|                                             | v2 `static_s5` before | after     | v3 `v3_static_s5` before | after     |
| ------------------------------------------- | --------------------- | --------- | ------------------------ | --------- |
| detectable, all units                       | 635 / 666             | 646 / 666 | 632 / 829                | 806 / 829 |
| detectable, scored by qc_eval               | 606 / 609             | 605 / 609 | 620 / 767                | 762 / 767 |
| P8                                          | 0.979                 | 0.979     | 0.824                    | **0.985** |
| R8                                          | 0.785                 | 0.787     | 0.960                    | 0.933     |
| cala cells matched to a non-detectable unit | 0                     | 0         | 116                      | **0**     |

On v3, P8 and P8x now agree (P8x was 0.982 before). R8 falls because the denominator now includes the dim cells cala also finds most of the time. The v2 numbers barely move: v2's wide blur kept almost every cell above the old floor.

**Ring check.** The v3 spec was rendered with v2's field curvature (2500 um), cells at 140-160 um, seed 5 and 480 s (GT only, not kept). Detectable cells on a 3 x 3 grid:

- 1.0.3 flag: `[[27,63,30],[66,14,49],[34,51,39]]`, a ring with 14 in the centre against a mean of 45 at the edges.
- 1.1.0 flag: `[[98,114,82],[118,125,97],[105,100,105]]`.

## Ground truth now on disk (minisim 1.1.0 flags; mean over seeds 5-9, range in brackets)

| arm                    | units | detectable before | detectable after |
| ---------------------- | ----- | ----------------- | ---------------- |
| v2 static              | 666   | 639 (635-642)     | 652 (646-655)    |
| v2 motion              | 722   | 679 (671-686)     | 688 (679-695)    |
| v2 halo                | 722   | 655 (650-664)     | 668 (661-678)    |
| v2 oof (target window) | 1047  | 650 (637-660)     | 666 (655-675)    |
| v3 static              | 829   | 649 (632-657)     | 805 (801-809)    |
| v3 motion              | 902   | 692 (666-711)     | 829 (812-850)    |
| size6 static           | 799   | 634 (618-650)     | 720 (710-732)    |
| size6 motion           | 864   | 674 (654-701)     | 738 (706-761)    |
| size16 static          | 846   | 677 (660-697)     | 837 (832-840)    |
| size16 motion          | 923   | 711 (680-745)     | 874 (864-887)    |

Where the files are:

- **v3:** the sims in `~/Projects/cala-data/sims-v3/` were rewritten in place.
- **v2:** the sims are in `~/Projects/cala-data/sims-gt110/` (`$CALA_SIMS_GT110`), as APFS clones of `sims/`. `sims/` keeps the 1.0.3 flags because the support-rule evaluation was reading it. Switch `CALA_SIMS` once that evaluation is done.
- **oof:** `oracle.bin` keeps the 200-280 um nuisance cells non-detectable, as before.

The minisim venv in `~/Projects/cala-data/venvs/minisim` is now 1.1.0; the previous pin was 01a9ce2, labelled 1.0.3.

Seed 5 only for the before/after table. The fit uses two seeds of one arm.
