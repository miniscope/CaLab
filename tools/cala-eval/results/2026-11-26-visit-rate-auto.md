# Auto Discover visit rate: new cells per visit sets the rate

26 Nov 2026. Branch `feat/cala-visit-rate-auto`. Raw runs, logs and scripts:
`~/Projects/cala-data/runs/visit-rate-auto/` (`scripts/summary.py`, `summary_short.py`, `summary_real.py`,
`yield_curve.py`; Chrome in `chrome/`).

## Summary

- Auto makes **fewer Discover visits** everywhere: 19 % fewer on the 9,600-frame sims, 55 % fewer on a
  30,000-frame static sim, 18 % fewer on a 30,000-frame sim with late-onset cells, and 29 % fewer on 15 min of
  real CA1 data.
- It **does not come for free**. Every arm loses a few cells:
  - 9,600-frame sims: recall −0.8 points [−1.2, −0.4] (paired over 8 runs). False cells do not change.
  - 30,000-frame static sim: 14 fewer matched cells (recall 0.887 → 0.870, n = 1).
  - Real data: 16 fewer cells (340 → 324, −5 %), 12 of them QC-pass (218 → 206).
- The **time saved is smaller than the visits saved**, and only clear on the long static sim:
  - qc_eval Discover time: −3 % on the 9,600-frame sims [CI spans zero], −8 % on real data, −19 % on the
    30,000-frame static sim (610 → 497 s), −4 % on the sparse late-onset sim.
  - Headed Chrome at Max: −3 % on the workshop recording (noise), −8 % on the 30,000-frame sim, with 32 and
    25 fewer cells respectively (see [Chrome](#headed-chrome-at-max)).
- So the claim "faster on long recordings with no recall loss" **does not hold as stated**. Auto is faster
  on long recordings once the field is mapped, at a cost of about 1–2 % of matched cells on sims and 5 % of
  cells on real data. Whether that trade is worth it, or whether `full_yield` should be lower (0.1) so the rate
  steps down later, is a decision for review (not rerun here).

## Setup

- qc_eval (`crates/cala/examples/qc_eval.rs`), engine from `c380b6b3` (main at the time) and the branch's
  first commit; no Rust has changed on main since, so the rebased branch runs the same engine.
- Arms:
  - main = `qc_eval --visit-rate 0.15` on `c380b6b3` (the fixed 0.15 rate, a bare cap).
  - fixed = the branch with `--visit-rate fixed`.
  - auto = the branch with `--visit-rate auto` (the default).
  - qc_eval runs the schedule with the cap at the target (`--visit-cap-ratio 1`, as a held Max run sits); the
    app's cap is 4/3 of the target.
- **fixed reproduces main exactly** on `v3_motion_s5` seed 1: 1,432 Discover visits over 9,600 frames,
  743 cells, adds 748 / merges 39 / splits 34, settle 5,064 visits / 7,999 refines / 89 publishes, work
  2.515e11. Only wall time differs (499 vs 469 s), from machine load. So "main" below is a valid fixed arm.
- Sims (minisim v3, 600 × 600 px, 20 fps): `v3_motion_s5`, `v3_motion_s6`, `v3_static_s6`, `v3_static_s7`
  (9,600 frames, seeds 1 and 2), and two 30,000-frame sims generated from the committed
  `ca1_workshop_v3.spec.json` (`make_trace_sim.py --dur 1500 --seed 5`):
  - `v3_static_long_s5`: the spec as is.
  - `v3_static_sparse_long_s5`: `--p-q2a 0.0001`, so cells keep turning on late in the recording.
- Real data: Samara 10_43_21 (17,879 frames), seeds 1 and 2. No ground truth: cells, QC pass, low SNR.
- Matching (`demix_metrics.py`): Hungarian on footprint correlation, r ≥ 0.7, against detectable GT units.
  Recall = matched / detectable. `tr_r` on main is NaN (its trace dumps were lost), ignore it there.
- Wall times are from one machine with other work on it: identical work took 469 vs 499 s above. Treat time
  differences under about 10 % as noise; visits are the reliable cost measure.

## 9,600-frame sims (8 paired runs)

| sim          | seed | arm  | visits / frame | Discover visits | cells | matched | false | recall | Discover s |
| ------------ | ---: | ---- | -------------: | --------------: | ----: | ------: | ----: | -----: | ---------: |
| v3_motion_s5 |    1 | main |          0.150 |           1,432 |   743 |     713 |    30 | 0.8748 |        326 |
| v3_motion_s5 |    1 | auto |          0.123 |           1,172 |   738 |     708 |    30 | 0.8687 |        388 |
| v3_motion_s5 |    2 | main |          0.150 |           1,432 |   746 |     710 |    36 | 0.8712 |        328 |
| v3_motion_s5 |    2 | auto |          0.123 |           1,178 |   733 |     702 |    31 | 0.8613 |        315 |
| v3_motion_s6 |    1 | main |          0.150 |           1,432 |   759 |     720 |    39 | 0.8738 |        334 |
| v3_motion_s6 |    1 | auto |          0.121 |           1,154 |   755 |     717 |    38 | 0.8701 |        311 |
| v3_motion_s6 |    2 | main |          0.150 |           1,432 |   771 |     730 |    41 | 0.8859 |        329 |
| v3_motion_s6 |    2 | auto |          0.124 |           1,182 |   761 |     728 |    33 | 0.8835 |        318 |
| v3_static_s6 |    1 | main |          0.150 |           1,432 |   740 |     737 |     3 | 0.9201 |        163 |
| v3_static_s6 |    1 | auto |          0.125 |           1,193 |   732 |     730 |     2 | 0.9114 |        162 |
| v3_static_s6 |    2 | main |          0.150 |           1,432 |   746 |     742 |     4 | 0.9263 |        166 |
| v3_static_s6 |    2 | auto |          0.118 |           1,123 |   730 |     728 |     2 | 0.9089 |        151 |
| v3_static_s7 |    1 | main |          0.150 |           1,432 |   710 |     707 |     3 | 0.8794 |        167 |
| v3_static_s7 |    1 | auto |          0.119 |           1,137 |   701 |     698 |     3 | 0.8682 |        149 |
| v3_static_s7 |    2 | main |          0.150 |           1,432 |   712 |     707 |     5 | 0.8794 |        164 |
| v3_static_s7 |    2 | auto |          0.125 |           1,189 |   708 |     704 |     4 | 0.8756 |        155 |

Auto − main, paired over the 8 runs (mean [t 95 % CI]):

| metric                | difference                 | relative |
| --------------------- | -------------------------- | -------: |
| Discover visits       | −266 [−287, −245]          |    −19 % |
| cells                 | −9 [−12, −5]               |   −1.2 % |
| matched               | −6 [−10, −3]               |   −0.9 % |
| false cells           | −2 [−5, +0]                |          |
| recall                | −0.0079 [−0.0121, −0.0037] |   −0.9 % |
| precision             | +0.0027 [−0.0002, +0.0056] |          |
| footprint r (matched) | +0.0002 [−0.0002, +0.0005] |          |
| Discover s            | −4 [−26, +19]              |   −2.7 % |
| Final settle s        | +1 [−4, +6]                |          |
| peak RSS GB           | −0.04 [−0.20, +0.12]       |          |

By kind: motion recall −0.0055 [−0.0107, −0.0003], static −0.0103 [−0.0194, −0.0012]. Main's seed-to-seed
spread on the same sim is 0–12 cells, so the loss is small but real.

The rate stays at 0.15 for the first ~60 % of these recordings (the fifths of the run, visits per frame:
0.146 / 0.150 / 0.150 / ~0.10 / ~0.05) and steps down only in the last 3,000–4,000 frames. That is too late to
save much time on a recording this short, and late enough to miss a few cells.

## 30,000-frame sims (one run each)

| sim                      | arm  | visits / frame | Discover visits | cells | matched | false | recall | Discover s | target at end |
| ------------------------ | ---- | -------------: | --------------: | ----: | ------: | ----: | -----: | ---------: | ------------: |
| v3_static_long_s5        | main |          0.150 |           4,492 |   739 |     728 |    11 | 0.8867 |        610 |          0.15 |
| v3_static_long_s5        | auto |          0.068 |           2,036 |   723 |     714 |     9 | 0.8697 |        497 |        0.0375 |
| v3_static_sparse_long_s5 | main |          0.150 |           4,492 |   459 |     457 |     2 | 0.7746 |        404 |          0.15 |
| v3_static_sparse_long_s5 | auto |          0.124 |           3,703 |   462 |     456 |     6 | 0.7729 |        388 |         0.075 |

Visits per Discover frame by fifths of the recording:

- static long, auto: 0.148 / 0.069 / 0.042 / 0.039 / 0.041 (first step down at frame 5,850, floor by 14,550).
- sparse long, auto: 0.149 / 0.144 / 0.116 / 0.108 / 0.099 (it keeps coming back to 0.15 while late cells
  turn on: 29 rung changes, never below 0.075).

Where the static long sim's cells come from (`yield_curve.py`, cells at the end of each 3,000 frames):

| frames      | 3k  | 6k  | 9k  | 12k | 15k | 18k | 21k | 24k | 27k | 30k |
| ----------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| main cells  | 611 | 691 | 709 | 713 | 723 | 732 | 733 | 738 | 738 | 739 |
| auto cells  | 611 | 687 | 701 | 709 | 714 | 711 | 714 | 718 | 722 | 724 |
| main visits | 450 | 450 | 450 | 450 | 450 | 450 | 450 | 450 | 450 | –   |
| auto visits | 450 | 441 | 232 | 182 | 137 | 111 | 111 | 123 | 132 | –   |

Main keeps finding a few cells all the way to 24,000 frames (+30 after 9,000) with 450 visits per 3,000
frames; Auto, at a third of the visits, finds +23 over the same stretch. The late cells are what the rate
trades for speed.

On the sparse sim, Auto holds recall (456 vs 457 matched) because the yield keeps the rate up, and saves
correspondingly little (18 % of visits, 4 % of time).

## Real data (Samara 10_43_21, 17,879 frames)

| arm  | seed | visits / frame | cells | QC pass | low SNR | Discover s |
| ---- | ---: | -------------: | ----: | ------: | ------: | ---------: |
| main |    1 |          0.150 |   340 |     219 |     117 |        538 |
| main |    2 |          0.150 |   339 |     217 |     120 |        534 |
| auto |    1 |          0.104 |   319 |     204 |     112 |        494 |
| auto |    2 |          0.109 |   328 |     208 |     116 |        490 |

Auto loses 16 cells on average (−5 %), 12 of them QC-pass (218 → 206, −5.5 %); main's seeds differ by 1 cell.
Discover time −8 %. The rate first steps down at frame 4,050 (seed 1) and 5,950 (seed 2), and spends the
rest of the run moving between 0.053 and 0.15 (21–29 rung changes). Real data keeps a yield of 0.05–0.14 new
cells per visit after 5,000 frames, which is in the range where the ladder steps down, so cells that main's
extra visits still find are missed.

## Headed Chrome at Max

Headed Chrome 156 on the real GPU (Metal), port 5277 / CDP 9377, `memory-measure.mjs --single --headed --lookback
--every 5`, `?debug`, Max, one run at a time with nothing else heavy running. Arms:

- main = `origin/main` (`f28b75f7`) JS tree with its own WASM (md5 `b575a1d9`, the same as main's in
  `2026-11-25-settle-visits-and-pool.md`). A real main arm, not this branch with `visitrate=fixed`: the branch
  also changes the governor's windows, so its fixed mode is not main in the app.
- auto = this branch (WASM md5 `0041fb7b`), default settings.

| run                  | frames | Discover s | Discover fps | Final settle s | Discover visits | visits / frame read | target at end (changes) | held at Max       | cells | matched / false (recall) | peak renderer GB, to final / all |
| -------------------- | -----: | ---------: | -----------: | -------------: | --------------: | ------------------: | ----------------------- | ----------------- | ----: | ------------------------ | -------------------------------: |
| workshop, main       | 23,711 |        117 |          202 |            155 |           3,671 |               0.155 | 0.15                    | 13 s, min 152 fps |   792 | –                        |                      5.63 / 5.63 |
| workshop, auto       | 23,711 |        113 |          210 |            151 |           3,226 |               0.136 | 0.075 (24)              | 12 s, min 159 fps |   760 | –                        |                      4.54 / 5.72 |
| 30k static sim, main | 30,000 |        201 |          150 |            110 |           4,815 |               0.161 | 0.15                    | 42 s, min 118 fps |   740 | 725 / 15 (0.883)         |                      3.79 / 4.38 |
| 30k static sim, auto | 30,000 |        185 |          162 |            106 |           1,968 |               0.066 | 0.0375 (20)             | 9 s, min 134 fps  |   715 | 708 / 7 (0.862)          |                      3.28 / 3.98 |

- **Workshop recording:** 12 % fewer visits, Discover 117 → 113 s (−3 %, within run-to-run noise), 32 fewer
  cells (792 → 760). Earlier main runs at Max on this recording gave 764–796 cells, so one run each cannot
  separate the cell drop from Max's run-to-run spread; it points the same way as the qc_eval real-data runs.
  At Max the slow worker also drops frames (about 5,200 of 23,700 in both arms), which caps how far the visit
  rate can fall per frame read; the target ended at 0.075 but visits per frame read stayed at 0.136.
- **30,000-frame sim:** 59 % fewer visits and much less holding (42 → 9 s), but Discover only 201 → 185 s
  (−8 %). Recall 0.883 → 0.862 (17 fewer matched cells), false cells 15 → 7. Same direction and size as qc_eval.
- **Memory:** no change beyond run-to-run noise (peaks to the final library 3.3–5.6 GB in both arms).
- So in the app at Max the speed gain is small: Discover's time at Max is mostly not visits.

Scoring of the sim libraries: `stage1-chrome/scripts/score_app.py` (the `demix_metrics.py` rule).

## Concerns

- **Recall cost.** Every comparison loses cells (sims −1 to −2 % of matched, real data −5 % of cells). The
  steps are set by `full_yield` 0.2: the rate starts falling while visits still find one new cell per 7–10
  visits. A lower `full_yield` (0.1) would step down later and cost fewer cells, and save less time.
- **Rung flapping.** 21–34 rung changes per run, often back and forth between neighbouring rungs within a few
  hundred frames (e.g. real seed 1: 0.106 → 0.15 → 0.106 within 2,000 frames). Harmless for results, but it
  shows the yield near the rung edges is noisy at these window lengths.
- **Chrome cell counts are single runs** at Max, where runs differ by up to ~30 cells; the qc_eval runs carry
  the quality comparison.
- **Speed is not proportional to visits.** 55 % fewer visits gave 19 % less Discover time on the long static
  sim; the rest of Discover's time (fast loop, adds, demixing) is not visits.
