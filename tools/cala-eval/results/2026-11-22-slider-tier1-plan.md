# Work slider, tier 1: arms and pass lines (committed before any run they judge)

22 Nov 2026. Branch `eval/cala-slider-tier1` ("PR 4" of the work-slider design,
`~/Projects/cala-data/demix-bench/work_slider_design.md`, sections 3 and 5). This file takes the arms and lines of
[2026-11-21-work-slider-plan.md](2026-11-21-work-slider-plan.md) for tier 1. Where it departs from that plan it says
**(amendment)** and why. Everything here is committed before the 60 fps Chrome pair and before any tier-1 run;
commit order is the proof. Results go in `2026-11-22-slider-tier1.md`.

## The questions

1. **Parity.** Below Max (paced 30 and 60 fps, with and without Background settle), does the library after the Final
   settle end as close to Max's as Max is to itself? Judged on Max's repeatable cells and their footprints. Extra
   cells are reported apart (PI, 21 Nov).
2. **Final-settle saving.** At each position, how much of the Final settle can be skipped without ending worse than
   the full pass? This feeds the adaptive Final settle (design section 3).
3. **Sizing.** Is a cap of 4 worth testing (L9)? Does a second look-back worker matter for quality (L8)?

## Step 1: close the 60 fps gap (C1 at 60)

#461 passed C1 at 30 fps and failed at full speed. It left 60 fps unverified: the only 60 fps Chrome runs predate
the smooth pacer.

- **Chrome:** this branch's app (`main` `4bd38908` app code: #459 accounting, #460 playback; the 30 fps references
  were `e8201322`; #460 changes the display only). `visit_refit_chrome.sh` with `OUT=.../work-slider-tier1/chrome`,
  Samara `10_43_21`, `--pacefps 60`, settle off (`sa-p60-off`) and on (`sa-p60-on`). One run each, headed, Metal
  GPU, port 5198, one at a time, no qc_eval run of mine going.
- **Model:** the tier-1 flags (section "Model flags"), `--offered-fps` = Chrome's achieved rate, slow seed 1, the
  same Discover as the tier-1 run, with no branches.
- **C1 rule (unchanged):** model within 15 % of Chrome on visit jobs in Discover, need-driven frames asked and
  background-settle frames per live frame (on row), and within 3 points on the share of frames the slow loop missed.
  Every row and measure on its own.
- **Reading, written now:**
  - both rows pass: `P-60` and `S-60` run in the model and decide.
  - the off row passes and the on row fails: `P-60` decides; `S-60` still runs but is reported as not deciding, and
    the parity of `S-60` is read from Chrome (n = 1).
  - the off row fails: the model runs at 30 fps only; 60 fps is read from Chrome only (n = 1), and the result file
    says so.

## Model flags (amendment: first use of this set)

Round 2 of #456 with `--visit-units-per-ms 2.3e6` and four forward buffers, as #461 recommends:
`--batch 8 --budget 30000000 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6
--visit-workers 4 --pool 4 --lb-gate --lb-ms 1.6 --lb-ms-per-cell 0.0082 --units-per-ms 1.6e6 --job-ms 1
--visit-units-per-ms 2.3e6 --lib-at 0.125,0.25,0.5,0.75`. Real: `--motion --fps 30`. Binary `qc_eval-tier1-940db2b6`
(this branch; `crates/` identical to #461's `qc_eval-refit-c`). Script: `tools/cala-eval/slider_tier1.sh`.
This exact set was never run before (#461's 30 fps passes used `--pool 2`; at 30 fps no batch was dropped, so the
pool did not act). The C1 pair at 60 fps is its first check.

## Arms

| arm    | offered rate                                              | Background settle                                                            |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `REF`  | Max: Chrome's achieved rate (`10_43_21` 343, `14_57_02` 348; sims 340) | off (`--csettle 0`)                                             |
| `P-30` | 30                                                        | off                                                                          |
| `P-60` | 60                                                        | off                                                                          |
| `S-30` | 30                                                        | cap 2 (`--csettle 0.667 --csettle-mode frames`), one look-back worker taking turns |
| `S-60` | 60                                                        | the same                                                                     |

Every run is one Discover, branched after it (`--branch-after discover`) into Final-settle budgets:

| branch | frames (T = recording length)    | how they are spread                                                                         |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `B0`   | 0                                | the live library at Discover's last frame                                                   |
| `B25`  | T/4                              | every 4th 64-frame block (`--settle-round T/4`), as the app's `settlePlan` spreads a short budget |
| `B50`  | T/2                              | every 2nd block                                                                             |
| `B75`  | 3T/4                             | three of every four blocks (three rounds of T/4)                                            |
| `B100` | T (Samara 17,879 / 17,875; sims 9,600) | in order, as the app's Final settle today; checkpoint libraries every 1,200 frames    |

All with `--settle-batch 16 --settle-check 1200`. `B100` is the arm's result for parity (today's full pass).

**Amendments to the arm list:**

- **The `S` arms are the plan's `S-f-1w`.** qc_eval has no `--lb-workers`: the background settle and the
  need-driven look-back share one modelled worker, as in the app today (#454). The two-worker `S-f` arm is not run.
- **No 2-pass branch.** The questions are about skipping Final settle, not adding to it. Dropping it saves about
  40 % of each run's wall time.
- **Workshop recording excluded from tier 1.** Reasons: #461 found the model's background-settle dose 39 % low there
  (0.99 against 1.62 at 30 fps); its Max rate is the furthest from calibration (Chrome misses 33 %); there is no
  smooth-pacer 60 fps reference; one 30 fps run costs about an hour. Tier 1 is Samara and sims only.
- **Max for sims = 340 fps**, an assumption (Samara's Chrome Max; the sims are 600 x 600 px like Samara).
- **Sims: the quick tier only** (static 5, 6, 7 and pairs 5, 6; n = 5; slow seed 1). Line L1 is judged on the
  14-sim tier, so the quick tier only screens.

**REF is outside the calibrated range (caveat, stated before the runs).** C1 failed at full speed: with four
buffers the model makes 56-62 % fewer visit jobs than Chrome at Max, and misses about 23 % of frames (Chrome 17-21 %).
Every parity number is relative to `REF`. If the model's `REF` is worse than Chrome's, the slider arms look better
than they are. Anchor: the same parity measures on the Chrome libraries (n = 1 per arm): `sa-max-off`, `sb-max-off`
(#461), a second `sa-max-off` run made here (the Chrome REF-REF null), and the arms `sa/sb-p30-off`,
`sa/sb-p30-on` (#461) and `sa-p60-off/on` (here). The Chrome libraries were all made by the app with today's
Final settle. Chrome's agreement uses `csettle_app_summary.py`'s match: greedy by cosine within 12 px, a pair at
cosine at least 0.7.

## Data and repeats

- **Real (model):** Samara `10_43_21` and `14_57_02` (read-only), slow seeds 1, 2, 3, five arms: 30 runs.
- **Sims (model):** the quick tier, five arms: 25 runs.
- **Chrome:** 3 new runs (`sa-p60-off`, `sa-p60-on`, `sa-max-off-r2`), plus #461's runs.
- Machine rules: at most 6 light qc_eval runs machine-wide, at least 5 GB free, at most 6 GB per run; no qc_eval run
  of mine during a Chrome run.

## Measures

Agreement between two libraries (real): cells matched one-to-one, greedily by footprint cosine, within 12 px, a
match at cosine at least 0.7 (the same function as `csettle_app_summary.py`, on both model and Chrome libraries).
Agreement = the median cosine of the matched pairs.

- **Agreement with `REF`:** arm `B100` against `REF` `B100` of the same recording and seed. The null: `REF` `B100`
  against `REF` `B100` of the other seeds of the same recording (3 pairs).
- **`REF`'s repeatable cells:** `REF` `B100` cells matched in at least 2 of the 3 `REF` seeds (counted on seed s's
  library: a cell of `REF` seed s is repeatable if it matches a cell of another `REF` seed). An arm of seed s has
  the cell if it matches it. Null (L2b): leave one seed out: the share of the cells that two `REF` seeds agree on
  that the third `REF` seed has.
- **Extra cells:** arm cells that match no cell of any `REF` seed; their held-out z (`ho_cells.tsv`) against that of
  `REF` cells found by one `REF` seed only.
- **Sims:** the suite's metrics (`demix_metrics`): footprint r with ground truth (all, close pairs, born in the
  second half), bitten footprints, matched and false cells.
- **Final-settle movement:** `settle_checks.tsv` of `B100`: share of cells moved above 2x their noise at the last
  checkpoint (L5).
- **Live library (L3):** gap closed at the last frame = (agree(arm `B0`, `REF` `B100`) - agree(`REF` `B0`, `REF`
  `B100`)) / (1 - agree(`REF` `B0`, `REF` `B100`)), same seed. **(Amendment: the plan had no formula; this is it.)**
- **Scheduler:** missed share, visit jobs, need-driven frames, background-settle frames per live frame, the look-back
  worker's busy share (from the run logs).

## Pass lines

Parity, per position (`P-30`, `S-30`, `P-60`, `S-60`), as in the plan:

| line | measure                                       | passes when                                                                                       |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| L1   | final footprint r, sims, all cells (screen)   | mean (arm - `REF`) >= -0.001 over the 5 sims; a mean below stops the arm. No pass is claimed from 5 sims |
| L1b  | footprint r, cells born in the second half    | lower 95 % CI bound >= -0.005 (quick tier: reported as a screen)                                  |
| L1c  | bitten footprints, sims                       | upper CI bound <= +0.02                                                                           |
| L1d  | false cells per sim                           | upper CI bound <= +3                                                                              |
| L2   | agreement with `REF`                          | >= the `REF`-`REF` null minus 0.003, on each recording (mean over the 3 seeds)                     |
| L2b  | `REF`'s repeatable cells present              | >= the leave-one-out null minus 3 points, on each recording                                       |
| L2c  | extra cells (reported, not a gate)            | their median held-out z >= that of cells only one `REF` seed has                                   |
| L4b  | frames the slow loop misses                   | <= 0.1 % (30 and 60 fps)                                                                          |
| L5   | moving share at the last `B100` checkpoint    | <= 4 %                                                                                            |

**A position has parity** when L2, L2b, L4b and L5 pass on both recordings and the sim screen (L1, L1b-d) does not
stop it. Real differences are also given as arm minus `REF`, paired by recording-seed, with a pooled paired
bootstrap 95 % CI over the 6 recording-seeds (seeds of one recording are not independent; the per-recording rows
decide a borderline case).

Final-settle saving, per position and per recording (sims: per sim):

- **`B*`** = the smallest of `B0`, `B25`, `B50`, `B75` that is **not worse than the arm's own `B100`**: agreement
  with `REF` `B100` at least `B100`'s minus 0.003 and `REF`'s repeatable cells present at least `B100`'s minus 3
  points (mean over the recording's 3 seeds; per seed reported); sims: footprint r
  (all) at least `B100`'s minus 0.001 and late-born r at least `B100`'s minus 0.005. If none is, `B*` = `B100`.
- Reported: frames saved = T - `B*`, as a share of the pass, per recording (and per seed), and the median and range
  over the 5 sims,
  and the same for `REF` (whose own `B*` is the baseline: what today's path could already skip).
- **The design's stop test (part B), read off the `B100` checkpoints:** the first checkpoint where at most 4 % of
  cells moved above 2x their noise at two checkpoints in a row and the median drift ratio R over the last three
  steps is at most 0.8 (design section 3). Reported: where it fires (frames), and agreement with `REF` `B100` at that
  checkpoint minus at `B100`'s end (it should be within 0.003 if the stop is safe). The full pass is read in order,
  so a stop at frame N has re-read only the first N frames; that is what the app would do if it stopped there.

Sizing:

- **L9 (is a cap of 4 worth testing):** worth testing if, at 30 fps, the background settle helps the live library
  (`S-30` minus `P-30` in gap closed: lower CI bound > 0, paired over the 6 recording-seeds) **and** `S-30` closes
  less than 75 % of the gap (room for more), **and** the modelled look-back worker is below 70 % busy at 30 fps
  (room to deliver 4). Not worth testing if `S-30` and `P-30` end the same after `B100` and in gap closed (dose 0 and
  dose 2 equal: more dose cannot help).
- **L8 (second look-back worker), not model-able directly.** Read from: (a) the delivered dose at 60 fps (Chrome
  `sa-p60-on`, and the model): at least 1.8 means one worker already delivers the cap at 60 fps; (b) `S-60` minus
  `P-60` after `B100` (L2) and in gap closed: if dose about 2 and dose 0 end equal, a second worker cannot matter for
  final quality at 60; it could still matter for the live library, which is then `S-60` against `S-30` in gap
  closed per unit of delivered dose.

What decides what: parity (L2, L2b, L4b, L5, with the sim screen) per position answers question 1; `B*` and the
stop test answer question 2; L8 and L9 answer question 3. Chrome rows (n = 1) are an anchor for the `REF` caveat and
do not override the model rows, except where the C1-at-60 reading above sends a 60 fps arm to Chrome.
