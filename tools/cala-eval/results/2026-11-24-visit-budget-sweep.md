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

**Suggested default (numbers revised by the Confirmation section at the end: floor 0.2 stands, target 0.25-0.3, cap
about 0.4 per frame over a whole recording): a fixed Discover visit rate in place of "whatever time is spare"**, with a floor and a cap. A
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

| arm (budget)   | visits / Discover frame | visits / settle frame | cells | false | precision | recall | Δ recall vs 1x          | fp r all | fp r < 1 D | trace r | bitten | wall Discover + settle (s) |
| -------------- | ----------------------: | --------------------: | ----: | ----: | --------: | -----: | ----------------------- | -------: | ---------: | ------: | -----: | -------------------------: |
| 0.5x (6.5e6)   |                   0.113 |                 0.472 |   519 |     4 |    0.9929 | 0.6392 | -0.124 [-0.144, -0.103] |   0.9848 |     0.9817 |  0.9832 |  0.273 |                    52 + 26 |
| 0.71x (9.2e6)  |                   0.160 |                 0.628 |   580 |     6 |    0.9892 | 0.7113 | -0.052 [-0.068, -0.035] |   0.9848 |     0.9822 |  0.9827 |  0.268 |                    56 + 30 |
| **1x (1.3e7)** |                   0.229 |                 0.860 |   624 |     9 |    0.9860 | 0.7628 | -                       |   0.9853 |     0.9835 |  0.9821 |  0.236 |                    62 + 36 |
| 1.41x (1.84e7) |                   0.308 |                 1.179 |   657 |     9 |    0.9858 | 0.8032 | +0.040 [+0.029, +0.052] |   0.9852 |     0.9835 |  0.9816 |  0.229 |                    69 + 43 |
| 2x (2.6e7)     |                   0.424 |                 1.629 |   678 |    16 |    0.9772 | 0.8218 | +0.059 [+0.041, +0.077] |   0.9846 |     0.9825 |  0.9814 |  0.227 |                    77 + 52 |
| 4x (5.2e7) *   |                   0.940 |                 0.732 |   715 |    27 |    0.9636 | 0.8538 | +0.091 [+0.076, +0.107] |   0.9838 |     0.9819 |  0.9807 |  0.202 |                   105 + 39 |
| 8x (1.04e8) *  |                   2.382 |                 0.758 |   728 |    35 |    0.9529 | 0.8590 | +0.096 [+0.078, +0.115] |   0.9836 |     0.9813 |  0.9806 |  0.218 |                   152 + 40 |

\* Added after the first read, to find where recall saturates. The Final settle is held near 1x with `--settle-steps`
0.3 and 0.15; the 0.15 arm is labelled `k0.1` in the tables file. They are not in the trend fit.

Trend fit (OLS on log2 of the budget, one intercept per sim, 30 runs): change from 0.5x to 2x against the seed SD
(pooled over 15 same-arm seed pairs).

| metric             | change 0.5x -> 2x [95 % CI] | seed SD | change / seed SD |
| ------------------ | --------------------------- | ------: | ---------------: |
| cells              | +158 [+142, +176]           |       9 |            +17.4 |
| recall             | +0.183 [+0.161, +0.204]     |  0.0119 |            +15.4 |
| precision          | -0.014 [-0.020, -0.008]     |  0.0036 |             -3.9 |
| false cells        | +11 [+6, +16]               |       2 |             +4.8 |
| footprint r, all   | -0.0000 [-0.0008, +0.0008]  |  0.0007 |             -0.0 |
| footprint r, < 1 D | +0.0011 [-0.0004, +0.0026]  |  0.0013 |             +0.8 |
| trace r (median)   | -0.0019 [-0.0024, -0.0014]  |  0.0004 |             -4.5 |
| bitten share       | -0.053 [-0.078, -0.026]     |   0.024 |             -2.2 |
| wall Discover (s)  | +26                         |       0 |                  |
| wall settle (s)    | +25                         |       0 |                  |

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

| arm                                    | visits / Discover frame | visits / settle frame | Δ cells | Δ recall                | Δ fp r all                 | Δ bitten                |
| -------------------------------------- | ----------------------: | --------------------: | ------: | ----------------------- | -------------------------- | ----------------------- |
| Discover 1x, settle 0.45x (steps 0.6)  |                   0.229 |                 0.386 |       0 | +0.000 [-0.000, +0.001] | -0.0006 [-0.0010, -0.0002] | +0.028 [+0.016, +0.040] |
| Discover 1x, settle 2.1x (steps 2.4)   |                   0.229 |                 1.810 |       0 | +0.000 [-0.000, +0.001] | +0.0004 [+0.0002, +0.0007] | -0.012 [-0.031, +0.006] |
| Discover 0.5x, settle 1.2x (steps 2.4) |                   0.113 |                 1.056 |    -105 | -0.124 [-0.144, -0.104] | -0.0004 [-0.0017, +0.0009] | +0.015 [-0.014, +0.043] |
| Discover 2x, settle 0.9x (steps 0.6)   |                   0.424 |                 0.771 |     +55 | +0.059 [+0.040, +0.078] | -0.0007 [-0.0027, +0.0013] | -0.008 [-0.047, +0.032] |

The whole cell-count effect comes from Discover. Changing settle visits 4.7-fold (0.39 to 1.81 per frame) moves
footprint r by 0.001 and bitten share by 0.04, and moves cells by none.

### Full length (`v3_static_s6`, 9600 frames, 2 seeds)

| arm  | visits / Discover frame | visits / settle frame | cells | false | precision | recall | fp r all | bitten | wall Discover + settle (s) |
| ---- | ----------------------: | --------------------: | ----: | ----: | --------: | -----: | -------: | -----: | -------------------------: |
| 0.5x |                   0.072 |                 0.243 |   708 |     1 |    0.9986 | 0.8833 |   0.9900 |  0.178 |                   140 + 87 |
| 1x   |                   0.143 |                 0.523 |   736 |     2 |    0.9966 | 0.9151 |   0.9900 |  0.148 |                  171 + 116 |
| 2x   |                   0.278 |                 1.121 |   750 |     6 |    0.9913 | 0.9276 |   0.9906 |  0.136 |                  227 + 167 |

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

## Confirmation: full-length motion sim and real data (24 Nov 2026)

Question: do the proposed numbers (floor about 1x, target about 2x, cap at most 4x of the budget; 0.2, 0.4 visits per
Discover frame on a 3000-frame clip) hold on a full-length motion recording and on real data? **In budget multiples: the
floor holds at 1x; 2x is not better than 1x by net matched cells or passing real cells, so the target is 1x to 2x and
the cap is 2x, not 4x.** The first verdict's numbers came from 3000-frame clips; on a full recording the same budget gives
fewer visits per frame (0.13-0.15 at 1x, not 0.2-0.23), and the curves flatten earlier. No arm tested a constant visits
per frame, which is what the proposal would build (see the verdict).

### Method

- Same binary and flags as the main sweep (`visit_budget_sweep.sh`, `visit_budget_real.sh`; qc_eval untimed `--budget`,
  `--settle-steps 1.2`; the 4x arm uses steps 0.3 to hold the Final settle near 1x, as before).
- **Motion:** `v3_motion_s5`, all 9600 frames, arms 0.5x, 1x, 2x, 4x, seeds 1 and 2 (8 runs). Metrics as in the main sweep.
- **Real:** Samara `10_43_21` (17879 frames, 30 fps, read-only), same four arms, seeds 1 and 2 (8 runs), `--motion --fps 30`,
  Thorough Final settle over all frames. No ground truth, so: cells in the final library; the app's QC colours from the last
  Discover checkpoint of `cells.tsv` (pass = SNR >= 5 and not a likely duplicate; low SNR = peak SNR < 5); a texture proxy
  (the repo has no texture metric: 3x3-smoothed footprint, mass of the largest component above half its peak over the
  footprint's mass, "textured" = share < 0.35); and cell correspondence between runs (Hungarian on footprint cosine >= 0.7).
- The PI's hand labels (299, 11 Nov) appear to be all on the workshop recording (the manifest names the Minian result and three cala runs; inferred, not checked), none on Samara, so they were not used.
- Visits per frame are measured, not nominal: **a given budget gives fewer visits per frame on a longer recording**
  (1x = 0.128 on the motion sim at 9600 frames, 0.146 on Samara at 17879, 0.229 on 3000 frames). Everything below is
  stated in measured visits per Discover frame over the whole recording.

### Full-length motion sim (`v3_motion_s5`, 9600 frames, 2 seeds)

| arm  | visits / Discover frame | visits / settle frame | cells | matched | false | precision | recall | matched - false |   fp r | trace r | bitten |
| ---- | ----------------------: | --------------------: | ----: | ------: | ----: | --------: | -----: | --------------: | -----: | ------: | -----: |
| 0.5x |                   0.066 |                 0.243 |   682 |     666 |    16 |    0.9765 | 0.8166 |             650 | 0.9879 |  0.9819 |  0.135 |
| 1x   |                   0.128 |                 0.494 |   730 |     699 |    31 |    0.9582 | 0.8577 |             669 | 0.9876 |  0.9811 |  0.135 |
| 2x   |                   0.238 |                 0.984 |   764 |     714 |    50 |    0.9345 | 0.8755 |             664 | 0.9862 |  0.9807 |  0.128 |
| 4x * |                   0.506 |                 0.446 |   792 |     722 |    70 |    0.9123 | 0.8859 |             653 | 0.9857 |  0.9804 |  0.132 |

\* settle steps 0.3. Seed pairs (cells): 683 / 680, 727 / 732, 762 / 765, 783 / 800. Per-run table: `visit_confirm_motion.py` output.

- Recall gains per doubling: +4.1, +1.8, +1.0 points. False cells grow by +15, +20, +20 per doubling and do not level off.
- **Matched minus false peaks at 1x** (650, 669, 664, 653). From 1x on, more visits add about as many false cells as matched
  ones. The 3000-frame clips showed recall still rising to 4x; at full length it has nearly stopped by 2x.
- Footprint r, trace r and bitten share stay flat (as in the main sweep).
- The motion sim keeps a false-cell excess at every rate: the static sim at full length had 1 / 2 / 6 false cells at 0.5x /
  1x / 2x, here 16 / 31 / 50.

### Where the false cells come from (motion, pooled over 2 seeds)

| arm  | false | split of a matched real cell | dim (undetectable unit) | unmatched detectable unit | no GT under it | peak SNR < 5 | QC fail | within 7.5 px of the edge |
| ---- | ----: | ---------------------------: | ----------------------: | ------------------------: | -------------: | -----------: | ------: | ------------------------: |
| 0.5x |    32 |                    21 (66 %) |                       1 |                         7 |              3 |            2 |       2 |                 11 (34 %) |
| 1x   |    61 |                    53 (87 %) |                       1 |                         3 |              4 |            3 |       6 |                 11 (18 %) |
| 2x   |   100 |                    87 (87 %) |                       1 |                         5 |              7 |           12 |      14 |                 15 (15 %) |
| 4x   |   139 |                   115 (83 %) |                       1 |                        10 |             13 |           17 |      19 |                 20 (14 %) |

(Class by best footprint r >= 0.3 against all GT units in cala's frame; "split" = that unit is detectable and already matched
to another estimate. 7.5 px = 1.5 x the registration's largest shift from the median, 5.0 px; 5 % of all cells lie there.
"False" is qc_eval's own match flag, as in the sweep tables.)

- **Mostly a second estimate on a cell that is already found, not noise.** 83-87 % of false cells at 1x and above have
  their best GT unit already matched to another estimate. Fewer than 10 % have nothing under them. The footprint r to that
  unit is 0.60-0.79 (median 0.70, 4x: 0.63 / 0.72 / 0.79 quartiles), so these are large overlapping copies rather than small
  fragments, just under the 0.7 strict-match line. qc_eval's own class agrees (table below): `dup` and `adjacent` make up
  83 % of the false cells at 4x.
- **QC does not catch them.** Median peak SNR of the false cells is 7.5-8.9 (matched: 29). At 4x only 12 % fall under SNR 5
  and 14 % fail QC; only 1-3 % have a trace correlated above 0.8 with a neighbour (which the likely-duplicate rule needs). The
  app would colour about 86 % of them as passing.
- **The motion border is over-represented but is not the main source.** Within 10 px of the edge the false rate is 18-25 %
  (4x: 23 of 91) against 0.7-3.4 % beyond 80 px; but the border supplies only 14 % of the false cells at 4x, and from 0.5x to
  4x the false count rises in every distance band (+10 within 10 px, +12, +25, +36, +24 beyond 80 px). Interior splits
  dominate.
- **They are born later than the real cells.**

  | arm  | median birth frame: false / matched | false born in the last third | matched born in the last third | false by qc_eval `fp_class` (last checkpoint)           |
  | ---- | ----------------------------------- | ---------------------------: | -----------------------------: | ------------------------------------------------------- |
  | 0.5x | 4621 / 1441                         |                         25 % |                            9 % | adjacent 12, dup 6, partial 9, tp 4, other 1            |
  | 1x   | 3117 / 996                          |                         22 % |                            4 % | adjacent 23, dup 23, partial 11, noise 2, tp 2          |
  | 2x   | 4514 / 689                          |                         33 % |                            2 % | adjacent 46, dup 38, partial 7, noise 4, tp 5           |
  | 4x   | 3041 / 617                          |                         19 % |                            3 % | adjacent 49, dup 66, partial 10, noise 7, tp 6, other 1 |

  (Birth = `recording_frame` of the cell's add in `adds.tsv`.) A second estimate on a found cell appears after that cell, so
  this is expected; it matters for a constant visit rate (verdict).

- Not tested: whether Refine or a merge pass removes these later. If it does, the cost of high visit rates is lower than the
  strict-match precision suggests.

### Real data (Samara `10_43_21`, 17879 frames, 2 seeds)

| arm  | visits / Discover frame | visits / settle frame | cells | QC pass | pass share | low SNR (< 5) | peak SNR median | textured | wall (min) |
| ---- | ----------------------: | --------------------: | ----: | ------: | ---------: | ------------: | --------------: | -------: | ---------: |
| 0.5x |                   0.078 |                 0.322 |   304 |     199 |       0.66 |            99 |             7.0 |    3.5 % |         12 |
| 1x   |                   0.148 |                 0.598 |   334 |     215 |       0.65 |           116 |             6.6 |    6.9 % |         14 |
| 2x   |                   0.293 |                 1.188 |   349 |     219 |       0.63 |           126 |             6.5 |    6.7 % |         17 |
| 4x * |                   0.652 |                 0.530 |   370 |     224 |       0.61 |           144 |             6.0 |    8.7 % |         18 |

Mean of 2 seeds; \* settle steps 0.3; wall = whole run, Discover and settle. Seeds differ by 1-9 cells in count
(299-308 / 333-334 / 347-350 / 369-370). "Textured" is the proxy defined above. Per-run table: `visit_confirm_real.py` output.

- Cell count keeps rising (+10 %, +4.5 %, +6 % per doubling), but **cells that pass QC saturate at about 1x-2x**: +16, +4,
  +5. Nearly all the extra cells at 2x and 4x fail QC on SNR: of the 36 cells added from 1x to 4x, 28 are low-SNR.
- Pass share falls from 0.66 to 0.61; median peak SNR from 7.0 to 6.0. The textured share is 3.5 % at 0.5x and 6.7-8.7 % from
  1x on, with 21-36 cells per run from 1x up. There is no sign of a different kind of artefact at high rates.
- **Cells that appear at 2x and 4x are not distinguishable from seed noise at 2x.** Cells without a 1-to-1 partner in the
  other run (a new cell or an extra piece of a split):

  | A against B               | no 1-to-1 partner | no counterpart at all | peak SNR median (no partner / matched) | QC pass share (no partner / matched) | textured (no partner / matched) |
  | ------------------------- | ----------------: | --------------------: | -------------------------------------- | ------------------------------------ | ------------------------------- |
  | 1x s1 vs 1x s2 (baseline) |            10.2 % |              20 / 334 | 5.2 / 6.9                              | 0.53 / 0.66                          | 14.7 % / 6.7 %                  |
  | 1x s2 vs 1x s1 (baseline) |             9.9 % |              16 / 333 | 4.8 / 7.0                              | 0.42 / 0.66                          | 12.1 % / 5.7 %                  |
  | 2x s1 vs 1x s1            |             9.5 % |              16 / 347 | 4.7 / 6.7                              | 0.45 / 0.67                          | 15.2 % / 5.1 %                  |
  | 2x s2 vs 1x s2            |            12.6 % |              27 / 350 | 4.5 / 6.9                              | 0.36 / 0.65                          | 11.4 % / 6.9 %                  |
  | 4x s1 vs 1x s1            |            13.8 % |              24 / 369 | 4.6 / 6.4                              | 0.41 / 0.63                          | 15.7 % / 6.3 %                  |
  | 4x s2 vs 1x s2            |            15.4 % |              34 / 370 | 4.9 / 6.4                              | 0.47 / 0.63                          | 22.8 % / 7.3 %                  |
  | 1x s1 vs 4x s1 (reverse)  |             4.8 % |               5 / 334 | 5.3 / 6.6                              | 0.69 / 0.65                          | 12.5 % / 7.2 %                  |
  | 1x s2 vs 4x s2 (reverse)  |             6.0 % |              10 / 333 | 5.2 / 6.8                              | 0.50 / 0.65                          | 0.0 % / 6.7 %                   |
  - At 2x the share (9.5-12.6 %) is inside the baseline (10 %); at 4x it is 14-15 %, about 4-5 points above.
  - Cells without a partner are the weak ones in every pair, baseline included: median SNR 4.5-5.3, about half fail QC.
  - Contour overlay of 4x against 1x (`~/Projects/cala-data/runs/visit-sweep/real/png/overlay_4x_vs_1x.png`, also 0.5x and
    2x): the cells with no partner are mostly irregular, large or streak-like outlines in dense patches and along the
    vessel-like streaks, not extra round somata. The runs keep no mean image, so the background is the 1x footprints.
  - About 95 % of the 1x cells have a partner at 4x.

### Verdict on floor, target and cap

Three scales are in play, so each value is given in all of them: the **budget multiple** (what the arms varied), the visits per
Discover frame **on a 3000-frame clip** (where the proposal's 0.2 and 0.4 came from), and the visits per frame **over a whole
recording** (what a fixed rate in the app would be). 1x is 0.229 on a 3000-frame clip, 0.128 on the full motion sim and
0.148 on Samara (17879 frames), so the same budget reads 0.13-0.15 over a whole recording.

| value  | budget multiple           | per frame, 3000-frame clip | per frame, whole recording | confirmed?              | reading                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------- | -------------------------: | -------------------------: | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| floor  | **1x**                    |                       0.23 |                  0.13-0.15 | **Yes**                 | At half of 1x (0.07-0.08 whole recording) the motion sim loses 4 points of recall and the real recording 30 cells (10 %), 16 of them passing QC.                                                                                                                                                                                                                                                                                                      |
| target | **1x to 2x** (about 1.5x) |                    0.3-0.4 |                    0.2-0.3 | **Not 2x as such**      | 1x to 2x adds 1.8 points of recall and 15 matched cells on the motion sim but also 19 false cells: matched minus false is 669 at 1x and 664 at 2x (per seed 667 / 670 against 664 / 663). The real recording gains 4 passing cells and 10 low-SNR ones (QC-passing per seed: 217 / 213 at 1x, 224 / 214 at 2x). The case for 2x over 1x rests on short recordings, where it still gives +5.9 points of recall (3000 frames) and reaches cells sooner. |
| cap    | **2x** (not 4x)           |                        0.4 |                   0.25-0.3 | **Lower than proposed** | From 2x to 4x the motion sim gains 1.0 point of recall and 8 matched cells and pays 20 false cells (precision -2.2 points); matched minus false falls to 653. The real recording gains 5 passing and 18 low-SNR cells. Paced runs at about 20x are deep in that regime.                                                                                                                                                                               |

Literal translation of the proposal into whole-recording rates: **floor 0.2 stands** (it is about 1.5x, above the knee; 0.15 is
the least that is needed), **target 0.4 does not** (about 3x, beyond the ceiling; use 0.2-0.3), and **cap 0.3** (about 2x),
with 0.4 as the absolute limit. Floor and target are then nearly the same number: one fixed rate near 0.25 per frame, with the
cap as a guard, would do.

**What this does not test: a constant visit rate.** Every arm is a fixed work budget, so the visit rate falls inside a run as
cells accumulate (seed 1, visits per Discover frame in thirds of the 9600 frames: 0.5x 0.073 / 0.051 / 0.044; 1x 0.139 / 0.098 /
0.085; 2x 0.299 / 0.192 / 0.163; 4x 0.694 / 0.406 / 0.366). A constant 0.25 gives fewer visits early than the 2x arm (0.30)
and more late (0.25 against 0.16). The false cells are born late (median 3000-4600 against 600-1400 for the matched ones; 19-33 %
in the last third against 2-9 %), so extra late visits may add more false cells than the budget arms show. Run a constant-rate
arm (or a short late-boost check) before fixing the numbers, or build with the cap low and measure.

- The target costs little: 2x adds about 20 % wall time to 1x on both recordings. 4x adds about 33 % (Samara, whole run,
  13.5 to 18 min) and 54 % (motion, Discover alone).
- Limits: one motion sim (two seeds) and one real recording (`10_43_21`; `14_57_02` was not run); "false" counts are strict-match
  counts and the second estimates may be healed later (Refine and merge not tested); the real-data judgement is QC and
  cross-run agreement only, with no ground truth; no hand labels on Samara (the 299 labels' candidates come from the Minian
  workshop result and three cala runs on the workshop recording, as read from the manifest, which names Minian and runs
  `r9`, `r1`, `r2g`; that these are all workshop runs is inferred, not checked); visits per frame are lock-step qc_eval (in
  the app, visits fill spare time and Chrome at Max also drops frames).

### Files

- Runs: `~/Projects/cala-data/runs/visit-sweep/v3_motion_s5_s<seed>_b<budget>_k<..>_f9600` and
  `~/Projects/cala-data/runs/visit-sweep/real/10_43_21_s<seed>_b<budget>_k<..>`; summaries `motion_full_summary.md`,
  `real/summary.md`, overlays `real/png/`. The per-run tables are appended to
  `2026-11-24-visit-budget-sweep-tables.md` (section "Confirmation").
- Scripts: `visit_budget_real.sh` (real runs), `visit_confirm_motion.py` (table, false-cell diagnosis, birth frames, visit-rate
  profile), `visit_confirm_real.py` (QC, texture proxy, cross-arm correspondence, overlays). Peak RSS 1.0-1.6 GB per run (the
  diagnosis script peaks at 3.2 GB). The Samara folder was only read.
