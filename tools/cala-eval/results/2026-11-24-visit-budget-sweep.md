# Visit budget sweep: does quality depend on visits per frame? (24 Nov 2026)

## Verdict

**Not flat.** Visits per frame in **Discover** decide how many cells cala finds, and at high rates how many false
cells it adds. Over the app's range (0.5x to 2x of Chrome at Max), the cell count moves by about 17 seed SDs. Visits in
the **Final settle** do not change the cell count.

- **Discover visits move the count.**
  - On the 3000-frame clips, 0.5x to 2x moves cells from 519 to 678, recall from 0.64 to 0.82 (+18 points) and false
    cells from 4 to 16. Precision falls by 1.4 points.
  - Recall rises by +7.2, +5.2, +4.0 and +1.9 points per step from 0.5x to 2x, so the gains shrink.
  - Recall levels off at about **4x** (0.94 visits per Discover frame): +3.2 points from 2x to 4x, +0.5 from 4x to 8x.
  - False cells keep rising: 16 / 27 / 35 at 2x / 4x / 8x, and precision falls to 0.977 / 0.964 / 0.953.
  - The rise is almost all on the motion sim, which reaches 59 and 77 false cells. They are truly false: re-matched
    against all GT units (`--all-det`) the unmatched counts are unchanged.
  - Almost all of the 0.5x to 2x effect is cells not yet found when the clip ends. Discover is still adding 70-160
    cells a minute at frame 3000. The Final settle adds fewer than 10.
- **The effect shrinks with recording length but stays.** Full 9600 frames of `v3_static_s6`, 2 seeds:
  - recall 0.883 / 0.915 / 0.928 at 0.5x / 1x / 2x;
  - 0.5x to 1x (+3.2 points) is about 3 seed SDs, and 1x to 2x (+1.3) about one;
  - the same sim at 3000 frames moved +16.8 points over 0.5x to 2x.
- **Per-cell quality is flat.**
  - Footprint r of matched cells, all and close pairs < 1 D, stays within seed noise (slope 0.0000 and +0.0006 per
    doubling).
  - Median trace r falls by 0.002 from 0.5x to 2x. That is the newly found, weaker cells, not worse traces.
  - Bitten share falls slightly with more visits (−0.05 over 0.5x to 2x, about 2 seed SDs).
- **Final settle visits barely matter.** With Discover held at 1x, settle visits from 0.39 to 1.81 per frame (0.45x to
  2.1x) change:
  - cells by 0;
  - footprint r by 0.001 (0.9846 to 0.9857);
  - bitten share from 0.264 to 0.223.

  The PI's −18 % to +36 % range in settle speed is well inside this. Settle speed is not a quality concern.
- **The app shows the same thing.** Chrome on the same clip (`csdelta/chrome-final`, `settle_readers_summary.py`):
  - At Max, 0.216 visits per Discover frame give 642-647 cells and recall 0.73-0.75. qc_eval at 1x gives 611-612 cells
    on `v3_motion_s5` and recall 0.73, so the calibration holds.
  - Paced at 30 fps, 4.7 visits per frame (about 20x) give 845-849 cells, recall 0.85, and 153-157 cells unmatched,
    against 39-49 at Max.
  - Pacing also removes the 25 % of frames Max drops, so this is not the visit effect alone. It still points the same
    way as the 8x arm: more real cells and many more false ones on motion.
- **The 390 vs 401 cells is within run noise.**
  - On this slope, ±3 % visits is about ±3 cells (0.5 %).
  - One seed SD (9 cells) is about ±8 % visits.
  - A difference of 11 cells is about 1.4 SD of a two-run difference, so it is the usual reshuffle between runs.
  - Chrome's spread over runs of the same clip (0.207-0.223 visits per frame) is inside ±8 %. The 0.22-0.29 range
    comes from two clip lengths (`sim3k` against `sim1k`), not from jitter.

**Suggested default: a fixed Discover visit rate in place of "whatever time is spare"**, with a floor and a cap. A
user-visible budget is not needed.

- **Floor at about 1x** (0.2 visits per observed Discover frame on a 600x600 field, the app's Max on a fast machine).
  - Below about 0.71x (0.15 per frame), recall drops by 5 or more points on 3000 frames and by about 3 points on 9600.
  - A slow machine at Max sits there.
- **Target about 2x** (0.4 per frame).
  - Above 2x, recall still gains about 3 points (on the short clips only), but false cells double on the motion sim.
  - At 4x and above, recall is saturated and only false cells grow.
- **Cap the visit rate when Discover is paced.**
  - Paced runs (30 fps) run at about 20x today, in the false-cell regime.
  - A cap would also make paced runs and Max runs give the same result.
- Supported by 3 sims at 3000 frames and one sim at full length. Before choosing the number, check it on a full-length
  motion sim and on real data.
- **The Final settle can stay as it is.** Its visit rate can float with machine speed.

## Results

Main sweep, 3 sims x 2 seeds per arm (n = 6), Final-settle steps 1.2, 3000 frames. Mean over runs; Δ = paired
difference against 1x [t 95 % CI]. Full per-run tables: `2026-11-24-visit-budget-sweep-tables.md`.

| arm (budget)    | visits / Discover frame | visits / settle frame | cells | false | precision | recall | Δ recall vs 1x            | fp r all | fp r < 1 D | trace r | bitten | wall Discover + settle (s) |
| --------------- | ----------------------: | --------------------: | ----: | ----: | --------: | -----: | ------------------------- | -------: | ---------: | ------: | -----: | -------------------------: |
| 0.5x (6.5e6)    |                   0.113 |                 0.472 |   519 |     4 |    0.9929 | 0.6392 | -0.124 [-0.144, -0.103]   |   0.9848 |     0.9817 |  0.9832 |  0.273 |                    52 + 26 |
| 0.71x (9.2e6)   |                   0.160 |                 0.628 |   580 |     6 |    0.9892 | 0.7113 | -0.052 [-0.068, -0.035]   |   0.9848 |     0.9822 |  0.9827 |  0.268 |                    56 + 30 |
| **1x (1.3e7)**  |                   0.229 |                 0.860 |   624 |     9 |    0.9860 | 0.7628 | -                         |   0.9853 |     0.9835 |  0.9821 |  0.236 |                    62 + 36 |
| 1.41x (1.84e7)  |                   0.308 |                 1.179 |   657 |     9 |    0.9858 | 0.8032 | +0.040 [+0.029, +0.052]   |   0.9852 |     0.9835 |  0.9816 |  0.229 |                    69 + 43 |
| 2x (2.6e7)      |                   0.424 |                 1.629 |   678 |    16 |    0.9772 | 0.8218 | +0.059 [+0.041, +0.077]   |   0.9846 |     0.9825 |  0.9814 |  0.227 |                    77 + 52 |
| 4x (5.2e7) *    |                   0.940 |                 0.732 |   715 |    27 |    0.9636 | 0.8538 | +0.091 [+0.076, +0.107]   |   0.9838 |     0.9819 |  0.9807 |  0.202 |                   105 + 39 |
| 8x (1.04e8) *   |                   2.382 |                 0.758 |   728 |    35 |    0.9529 | 0.8590 | +0.096 [+0.078, +0.115]   |   0.9836 |     0.9813 |  0.9806 |  0.218 |                   152 + 40 |

\* Added after the first read, to find where recall saturates. The Final settle is held near 1x with `--settle-steps`
0.3 and 0.15; the 0.15 arm is labelled `k0.1` in the tables file. They are not in the trend fit.

Trend fit (OLS on log2 of the budget, one intercept per sim, 30 runs): change from 0.5x to 2x against the seed SD
(pooled over 15 same-arm seed pairs).

| metric               | change 0.5x -> 2x [95 % CI]  | seed SD | change / seed SD |
| -------------------- | ---------------------------- | ------: | ---------------: |
| cells                | +158 [+142, +176]            |       9 |            +17.4 |
| recall               | +0.183 [+0.161, +0.204]      |  0.0119 |            +15.4 |
| precision            | -0.014 [-0.020, -0.008]      |  0.0036 |             -3.9 |
| false cells          | +11 [+6, +16]                |       2 |             +4.8 |
| footprint r, all     | -0.0000 [-0.0008, +0.0008]   |  0.0007 |             -0.0 |
| footprint r, < 1 D   | +0.0011 [-0.0004, +0.0026]   |  0.0013 |             +0.8 |
| trace r (median)     | -0.0019 [-0.0024, -0.0014]   |  0.0004 |             -4.5 |
| bitten share         | -0.053 [-0.078, -0.026]      |   0.024 |             -2.2 |
| wall Discover (s)    | +26                          |       0 |                  |
| wall settle (s)      | +25                          |       0 |                  |

By the pre-registered rule this is **not flat**: cells, recall, precision, false cells, trace r and bitten share all
move by more than one seed SD. Footprint r is the only flat quality metric.

Per sim (mean of 2 seeds), recall at 0.5x / 1x / 2x and false cells at 2x:

| sim            | recall 0.5x | recall 1x | recall 2x | false cells 0.5x / 1x / 2x |
| -------------- | ----------: | --------: | --------: | -------------------------: |
| `v3_motion_s5` |        0.62 |      0.73 |      0.81 |               10 / 17 / 33 |
| `v3_static_s6` |        0.68 |      0.79 |      0.84 |                  0 / 4 / 6 |
| `v3_static_s7` |        0.62 |      0.76 |      0.81 |                  1 / 5 / 7 |

On the motion sim more visits keep adding real cells and false ones. Precision there is 0.98 / 0.97 / 0.95.

### Stage split: Discover against Final settle

Same 6 (sim, seed) pairs; Δ against 1x / steps 1.2.

| arm                                   | visits / Discover frame | visits / settle frame | Δ cells | Δ recall                | Δ fp r all              | Δ bitten                |
| ------------------------------------- | ----------------------: | --------------------: | ------: | ----------------------- | ----------------------- | ----------------------- |
| Discover 1x, settle 0.45x (steps 0.6) |                   0.229 |                 0.386 |       0 | +0.000 [-0.000, +0.001] | -0.0006 [-0.0010, -0.0002] | +0.028 [+0.016, +0.040] |
| Discover 1x, settle 2.1x (steps 2.4)  |                   0.229 |                 1.810 |       0 | +0.000 [-0.000, +0.001] | +0.0004 [+0.0002, +0.0007] | -0.012 [-0.031, +0.006] |
| Discover 0.5x, settle 1.2x (steps 2.4)|                   0.113 |                 1.056 |    -105 | -0.124 [-0.144, -0.104] | -0.0004 [-0.0017, +0.0009] | +0.015 [-0.014, +0.043] |
| Discover 2x, settle 0.9x (steps 0.6)  |                   0.424 |                 0.771 |     +55 | +0.059 [+0.040, +0.078] | -0.0007 [-0.0027, +0.0013] | -0.008 [-0.047, +0.032] |

The whole cell-count effect comes from Discover. Changing settle visits 4.7-fold (0.39 to 1.81 per frame) moves
footprint r by 0.001 and bitten share by 0.04, and moves cells by none.

### Full length (`v3_static_s6`, 9600 frames, 2 seeds)

| arm | visits / Discover frame | visits / settle frame | cells | false | precision | recall | fp r all | bitten | wall Discover + settle (s) |
| --- | ----------------------: | --------------------: | ----: | ----: | --------: | -----: | -------: | -----: | -------------------------: |
| 0.5x |                  0.072 |                 0.243 |   708 |     1 |    0.9986 | 0.8833 |   0.9900 |  0.178 |                   140 + 87 |
| 1x   |                  0.143 |                 0.523 |   736 |     2 |    0.9966 | 0.9151 |   0.9900 |  0.148 |                  171 + 116 |
| 2x   |                  0.278 |                 1.121 |   750 |     6 |    0.9913 | 0.9276 |   0.9906 |  0.136 |                  227 + 167 |

The same budget gives fewer visits per frame on the full recording, because a visit costs more as cells accumulate.
The app's time-limited visits should behave the same way, but this was not measured in Chrome at 9600 frames. The
recall gap closes from 16.8 points (3000 frames) to 4.4 points (9600 frames), and 1x to 2x is within about one seed SD.

### Calibration runs (seed 1, `v3_motion_s5`, 3000 frames, settle steps 1)

| budget | visits / Discover frame | visits / settle frame | cells | recall |
| -----: | ----------------------: | --------------------: | ----: | -----: |
|    9e6 |                   0.147 |                  0.52 |   568 |  0.686 |
|    3e7 |                   0.439 |                  1.45 |   701 |  0.825 |

A 3.3x budget gives 3.0x the visits in Discover and 2.8x in the settle, so the budget binds in both stages.

## Files

- Runs: `~/Projects/cala-data/runs/visit-sweep/<sim>_s<seed>_b<budget>_k<100 x steps>[_f9600]` (calibration under
  `calib/`).
- Binary: built from `main` `5400ead7` (`target-visit-sweep`).
- Scripts: `visit_budget_sweep.sh` (`all`, `stage`, `long`) and `visit_budget_summary.py`.
- Peak RSS: 1.0-1.6 GB per run. At most two runs at a time.

## Background

Question (PI): in the app, tile visits fill whatever time the slow worker has spare, so visits per frame vary with the
machine and with scheduling (two runs of one sim gave 390 against 401 cells). Is quality flat over that range? If it is,
no user-visible visit budget is needed; if not, one is.

## Method (written before the main sweep was read)

- **Knob: qc_eval's existing `--budget`** (no code change). In the lock-step (untimed) mode each Discover frame earns
  `--budget` work units and each Final-settle frame `--settle-steps` x `--budget`; `SlowLoop::step` spends them on due
  tiles, most-fresh first, and drops credit when nothing is due. For a given `--slow-seed` the run is deterministic.
  The calibration runs below show that the budget binds in both stages (visits per frame scale almost linearly with it).
- **Calibration to the app.** Chrome (`runs/csdelta/chrome-final`, headed, Max, `sim3k` = the first 3000 frames of
  `v3_motion_s5`; `csdelta_chrome_final.py --discover`): **0.216 visit jobs per observed Discover frame** (0.27 on the
  first 1000 frames). Final settle: about **0.7-1.1 visits per settle frame** (PI's Chrome readings). The same clip in
  qc_eval (seed 1): budget 9e6 gives 0.147 per Discover frame and 0.52 per settle frame; 3e7 gives 0.439 and 1.45.
  So **1x = `--budget 1.3e7` with `--settle-steps 1.2`** (about 0.21 and 0.9). qc_eval's long-standing default
  (`--budget 3e7`, steps 1) is about 2x the app in Discover and 1.6x in the settle.
- **Arms:** budget 0.5x, 0.71x, 1x, 1.41x, 2x (6.5e6, 9.2e6, 1.3e7, 1.84e7, 2.6e7), settle steps 1.2 throughout, so
  Discover and the Final settle move together.
- **Sims:** `v3_motion_s5` (motion, `--motion`), `v3_static_s6`, `v3_static_s7`; the first 3000 frames each (the clip
  the Chrome numbers come from); slow seeds 1 and 2. 30 runs.
- **Flags** (the app's recording path in qc_eval, as `csdelta_final.sh`): `--batch 8 --passes 1 --joint-update all
  --joint-sign all --lookback 2 --merge-guard-sep 0.6 --lookback-drain 0 --settle-frames 3000 --settle-batch 16`
  (look-back on, the Thorough Final settle over all 3000 frames), plus `--dump --no-signed --no-heldout`.
- **Metrics** (`demix_metrics.py`, then `visit_budget_summary.py`): cells; matched (Hungarian on footprint r >= 0.7,
  detectable GT units); false; precision = matched / cells; recall = matched / detectable units; mean footprint r of
  matched cells, all and those whose nearest GT neighbour is < 1 soma diameter away; median trace r; bitten share
  (matched neighbour pairs whose estimated footprint at the neighbour's centre is < 0.5 of the truth's); qc_eval's own
  GT precision / recall / trace r; wall seconds of Discover and of the settle; peak RSS.
- **Rule for "flat".** Per metric, an OLS slope on log2(budget scale) with one intercept per sim, over the 30 runs.
  Flat if the fitted change over the app's range (0.5x -> 2x, two doublings) is smaller than the seed SD (pooled over
  all 15 same-arm seed pairs) for every quality metric, and the 95 % CI of the slope includes 0 for recall, precision
  and footprint r. Otherwise not flat, and the per-arm table says where it saturates (the lowest arm within one seed SD
  of 2x).
- **If not flat:** a stage split (Discover 0.5x / 2x with the settle at 1x, and the reverse, via `--settle-steps`), and
  full-length runs (9600 frames) of `v3_static_s6` at 0.5x / 1x / 2x to see whether the effect shrinks with length.

Caveats known up front:

- The match is per observed frame. Chrome at Max also misses about 25 % of frames on the slow loop and runs four
  visit workers in parallel; lock-step observes every frame and visits in order.
- Recall uses the full recording's detectable flags on a 3000-frame clip, so it is low in every arm by the same amount.
- Two runs at a time: wall seconds carry some contention; the visit counts are exact.
- qc_eval's own `gt_*` columns (tables file) do not move with the settle-only arms. They appear to be read at the last
  checkpoint before the Final settle, which was not checked in the code. The verdict uses the demix_metrics columns.
