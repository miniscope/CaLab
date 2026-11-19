# Look-back review: is a settled look-back Discover enough to drop Refine? (19 Nov 2026)

Targets written 19 Nov 2026 before any run of this review (commit order shows it). Results go below them.

## Questions

1. Does a Refine pass after a settled look-back Discover (COMBO) still improve the library, or only move it?
2. Is the settling stop rule (no cell with an unserved block of its `K`-frame window) a convergence rule?
3. Is Refine slower after a look-back run because of the COMBO slow-loop settings?
4. Can settling use bigger batches once Discover has ended?
5. Does the workshop recording agree with the sims?

## Binary and arms

One binary for every arm: this branch's `qc_eval` (main bbe6e287 plus three eval-only flags; no library change):

- `--lookback-drain` may now be used with `--passes N` > 1: the drain runs at the end of pass 1, then the later passes
  run as before (a Refine after a settled look-back Discover, as the app does when Refine is pressed after it).
- `--lookback-drain-rate F`: look-back frames per drain step (default: the `--lookback` rate).
- `--noise-dump` with `--wrap-libs` also writes the split-half footprint noise at every wrap (`fp_noise_wrap{k}.tsv`).

Sim arms (full tier: static s5-s9, motion s5-s9, pairs s5-s8; suite defaults for everything not named):

| arm                      | flags                                                                                                     | what it is                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `DR-main`                | suite default (`--passes 2 --later-passes refine`)                                                        | Discover + 1 Refine, look-back off  |
| `COMBO`                  | `--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --merge-guard-sep 0.6` | the shipped look-back configuration |
| `COMBO+R`                | COMBO with `--passes 2 --later-passes refine --wrap-libs --noise-dump`                                    | COMBO, then one Refine              |
| `DRR`                    | `--passes 3 --later-passes refine --wrap-libs --noise-dump`                                               | Discover + 2 Refines (the null)     |
| `COMBO-d16`, `COMBO-d64` | COMBO with `--lookback-drain-rate 16` / `64`                                                              | bigger settling batches             |

Checks before the arms are trusted: `DR-main` and `COMBO` of this binary are byte-identical to `combo-full` (main
f14efd8c) on static_s5, pairs_s5 and motion_s5 (`footprints.bin`, `dump_trace.f32`); if so the `combo-full` runs are
reused for those two arms. `COMBO+R`'s wrap-1 library is byte-identical to `COMBO`'s final library.

## Targets

**T1. Does Refine after look-back still improve footprints (sims, ground truth)?** `COMBO+R` minus `COMBO`, suite rules
(paired, 95 % CI, 14 sims), also for the motion sims alone.

- Refine adds nothing that matters (go for dropping it) when all of: footprint r median for all, isolated and
  close-pair cells gains at most 0.002 (point estimate); crosstalk headline (corr excess < 1 D) improves by at most
  0.02; share r < 0.9 within noise; matched and false cells within noise.
- Refine still helps (no-go) when any footprint group gains more than 0.002 with a CI that excludes 0, or the headline
  improves by more than 0.02 with a CI that excludes 0. The group is named.
- Reported either way: `COMBO+R` vs `DR-main`, and the birth-time rows (second half, last 20 %).

**T2. Reproduction.** `COMBO` vs `DR-main` reproduces the full-tier table of
[2026-11-19-no-refine-full-tier.md](2026-11-19-no-refine-full-tier.md) (byte-identical runs, or every row within its CI).

**T3. Is the settled library converged (sims)?** Per cell, same id before and after a Refine pass, three numbers:
the app's "change" (relative L2, `|a' - a| / |a|`, amplitude included), a shape-only change (1 - cosine of the two
footprints), and the change in r with ground truth. Libraries: `COMBO` → `COMBO+R` (wrap 1 → final), and for scale
`DRR` wrap 1 → wrap 2 (the first Refine after a plain Discover) and `DRR` wrap 2 → final (a second Refine: the null,
what a Refine does to a library that already had one). Per-sim medians, paired CI over sims.

- Settled: the median change of `COMBO` → `COMBO+R` is at most 1.25 x the null (second Refine), on both the app's
  metric and the shape-only one; and at most the median split-half noise of the cells at wrap 1 (the plan's Gate A
  settled check).
- Not settled: above 1.5 x the null on the shape-only metric (CI excluding 1.25 x).
- Moving without improving: the share of cells whose r with ground truth rises is within 45-55 % and the mean change
  in r is within +-0.0005, while the app's change is above the null.
- Also reported: the same three numbers by group (isolated, close-pair, born in the last 20 %), and the share of cells
  the app would call "refined" (any change at all).

**T4. Refine cost under the COMBO slow-loop settings.** Controlled timing on static s5-s7: the arms of one sim run
together, 3 runs at once and nothing else. Arms: `DR-main`, `DR-st2g` (`--joint-update all --joint-sign all
--merge-guard-sep 0.6`, Refine with the COMBO slow-loop settings, no look-back), `COMBO+R`. Measure: wall of pass 2
(`passes.tsv`), ms per frame, and slow-loop work units per frame of pass 2.

- The settings explain the app's slowdown (about 2 x) when pass-2 wall of `DR-st2g` or `COMBO+R` is at least 1.5 x
  `DR-main`'s on every sim.
- They do not when the ratio is at most 1.2 on every sim; then the app's slowdown is in the app (workers, messages),
  and the code is read for it.
- In between: partly.

**T4b. Refine speed in the app (added 19 Nov before any browser run; qc_eval's slow loop is budget-paced, so its
pass-2 wall cannot show an app-side slowdown).** Headed Chrome, real GPU, `apps/cala/scripts/memory-measure.mjs
--single --headed` on the workshop recording, dev build of main bbe6e287, one run at a time, 2 runs per arm: look-back
off (Discover, Refine) and look-back on (`--lookback --refine`: Discover, settling, Refine). Measure: median Refine
fps over the samples of the Refine run, Refine wall, settling wall.

- The PI's observation is reproduced when Refine fps with look-back on is at most 0.7 x the look-back-off value in
  both pairs.
- If reproduced, one more arm from a build with `LOOKBACK.jointUpdate = 'off'` (look-back on, cluster replay off)
  separates the settings from the look-back plumbing: the settings are the cause when that arm's Refine fps is back
  within 15 % of look-back off.

**T5. Bigger settling batches.** `COMBO-d16` and `COMBO-d64` vs `COMBO`, full tier.

- Go when: footprint r median (all, isolated, close-pair) within 0.001 of `COMBO`; headline within 0.01; matched within
  1 %; false within noise; birth-time rows within noise; and drain steps fall by at least 3 x.
- Reported: drain steps, drain frames, drain wall, look-back wall.

**T6. Real data (workshop recording, 600 x 600, 18,000 frames, `qc_eval real --motion --frames 18000 --batch 8
--budget 30000000 --dump`, held-out score on).** Two runs per slow seed (1 and 2): `DRR` (`--passes 3 --later-passes
refine --wrap-libs`: its wraps are Discover, D + R, D + 2R) and `COMBO+R` (wraps: COMBO, COMBO + R). Two heavy runs at
a time, RAM under 6 GB each. No ground truth; Minian is a reference only.

- Change sizes by id, as T3: `COMBO` → `COMBO+R`, D → D + R, D + R → D + 2R (the null). The app showed 28.2 % median
  for the first; this run says whether qc_eval reproduces it and how it compares with the other two.
- Settled on real data: `COMBO` → `COMBO+R` shape-only change at most 1.25 x the null (D + R → D + 2R). Not settled:
  above 1.5 x.
- Agreement between libraries (Hungarian match on footprint correlation >= 0.7): share of cells matched and median
  footprint r of the matches, for `COMBO` vs D + R, `COMBO+R` vs D + R, `COMBO+R` vs D + 2R, with the seed 1 vs seed 2
  agreement of the same arm as the noise floor. Refine "moves COMBO toward D + R" if agreement rises by more than the
  seed-to-seed spread.
- Quality without ground truth: held-out score of each library (`final*.tsv` `ho_*`, `heldout.tsv`) and cell counts.
  `COMBO` is good enough on real data when its held-out score is not below D + R's by more than the seed-to-seed
  difference, and the Refine after it does not raise the held-out score by more than that difference.
- Minian agreement (share of Minian units matched) reported for each library, no pass/fail.

## Decision rule

- **Go** (default-on, Refine hidden under Advanced): T1 says Refine adds nothing that matters, T3 and T6 say settled
  (or moving without improving), and T6's held-out score does not favour a Refine after COMBO.
- **Go with a longer or different settle**: T1 or T6 show a gain from Refine that is concentrated in a nameable group
  (late-born, isolated); the recommendation is then the stop-rule change that gives that group its frames.
- **No-go** (keep Refine visible): Refine after COMBO gains more than 0.002 footprint r broadly, or the real-data
  held-out score clearly favours COMBO + R.

## Results (19 Nov 2026)

Binary `qc_eval-lbreview-a` (this branch, f8de6a04). Run trees: `$CALA_DATA/demix-suite/lbreview-full` (sims; reports
`report-*.md`, `settled.md`), `$CALA_DATA/demix-suite/lbreview-t4` (timing), `$CALA_DATA/runs/lbreview/real` (workshop
recording; `change_agreement.md`), `$CALA_DATA/runs/lbreview/browser` (headed Chrome).

Checks: `DR-main` and `COMBO` of this binary are byte-identical to `combo-full` on static_s5, pairs_s5 and motion_s5
(`footprints.bin`, `dump_trace.f32`), so those two arms are the `combo-full` runs (T2: reproduced exactly). `COMBO+R`'s
wrap-1 library is byte-identical to `COMBO`'s final library (static_s5, motion_s5).

### In plain language

- **A Refine after a settled look-back Discover still improves the library.** On the sims it raises footprint r in
  every group (+0.003), most for cells born late (+0.02 to +0.04), halves the remaining bites and lowers crosstalk a
  little. By the rule written above this is the no-go case for dropping Refine as it stands.
- **Look-back still meets the bar the PI set (Discover + 1 Refine) on the sims.** `COMBO` vs `DR-main` is unchanged.
  The sims therefore say: look-back equals the old Discover + Refine, and look-back + Refine is better than both.
- **On the workshop recording look-back does not reach Discover + Refine.** By every measure that needs no ground
  truth (agreement between two seeds, agreement with Minian, split-half footprint noise), the settled look-back
  library looks like a plain Discover library, and a Refine after it moves footprints as much as a Refine after a
  plain Discover (28-30 % against 24-26 %; a second Refine moves them 10 %). The sims understate what Refine does on
  real data by about 4 x.
- **"Settled" means the bookkeeping is done, not that footprints stopped changing.** The stop rule ends when every
  cell has been served the 3000 frames before its birth.
- **Refine is slower after a look-back run because of the cluster replay** the look-back slow loop is built with
  (about 0.6 x the frame rate in the app; the Refine pass's per-frame observe cost doubles on the workshop
  recording). With the replay off and look-back on, Refine is back to full speed.
- **Settling is slow because of lock-step, not work.** In the app it re-reads about 14 frames per second, against
  about 200 per second while Discover runs. Sixteen frames per step keeps overall quality on the sims with 8 x fewer
  steps, but late-born cells get more bites, because the visit rounds fell with the steps. Batching frames while
  keeping the visit rounds was not tested.

### T1. Refine after look-back, sims (full tier, 14 sims; diff = `COMBO+R` - `COMBO`, 95 % CI)

| metric                                 | DR-main | COMBO  | COMBO+R | COMBO+R - COMBO          | COMBO+R - DR-main         |
| -------------------------------------- | ------- | ------ | ------- | ------------------------ | ------------------------- |
| footprint r, all                       | 0.9879  | 0.9899 | 0.9928  | +0.0029 [0.0025, 0.0033] | +0.0048 [0.0043, 0.0054]  |
| footprint r, isolated                  | 0.9922  | 0.9899 | 0.9924  | +0.0025 [0.0013, 0.0035] | +0.0002 [-0.0007, 0.0013] |
| footprint r, close-pair                | 0.9843  | 0.9895 | 0.9928  | +0.0033 [0.0027, 0.0039] | +0.0085 [0.0076, 0.0093]  |
| share r < 0.9, all                     | 0.056   | 0.052  | 0.036   | -0.016 [-0.023, -0.008]  | -0.020 [-0.027, -0.012]   |
| footprint r, born second half          | 0.9560  | 0.9575 | 0.9781  | +0.0206 [0.0148, 0.0255] | +0.0221 [0.0158, 0.0288]  |
| footprint r, born last 20 %            | 0.9306  | 0.9235 | 0.9646  | +0.0410 [0.0235, 0.0609] | +0.0339 [0.0195, 0.0459]  |
| share r < 0.9, born last 20 %          | 0.323   | 0.385  | 0.177   | -0.208 [-0.325, -0.092]  | -0.146 [-0.255, -0.042]   |
| crosstalk headline (corr excess < 1 D) | +0.150  | +0.086 | +0.074  | -0.011 [-0.021, -0.002]  | -0.076 [-0.085, -0.066]   |
| bite share < 0.5, 0.75-1 D             | 0.486   | 0.283  | 0.165   | -0.119 [-0.147, -0.091]  | -0.321 [-0.352, -0.291]   |
| matched cells                          | 400.1   | 400.9  | 401.9   | +0.9 [-0.3, 2.2]         | +1.7 [-0.6, 4.0]          |
| false cells                            | 21.9    | 18.1   | 17.1    | -0.9 [-2.2, 0.3]         | -4.7 [-7.6, -1.9]         |
| cells matching 2+ GT units             | 148.6   | 166.7  | 177.1   | +10.4 [6.0, 14.7]        | +28.4 [20.0, 36.9]        |

Per kind, footprint r gain of the Refine (`COMBO+R` - `COMBO`, per-sim medians, paired t CI): motion all +0.0031
[0.0026, 0.0036], isolated +0.0026, close-pair +0.0036; static +0.0031 / +0.0023 / +0.0035; pairs +0.0010 / +0.0023 /
+0.0013. Flagged worse for `COMBO+R` vs `COMBO`: `leak_sd` share > 0.1 for later-born cells (0.204 -> 0.255) and cells
matching 2+ GT units (the suite counts accurate footprints of close pairs there; see the full-tier note).

**Verdict T1: Refine still helps (no-go rule).** Every footprint group gains more than 0.002 with a CI that excludes
0; the largest gains are the cells born late. The headline improves by 0.011 (under the 0.02 line). Matched and false
cells do not change. `COMBO+R` is the best arm measured so far against `DR-main` and equals it on isolated cells.

### T3. Is the settled library converged? (sims; per-sim medians, mean over 14 sims [95 % CI]; `settled.md`)

| step                                  | change, app metric | shape-only change (1 - cos) | split-half noise before | change / noise | mean change in r with GT | share with r up |
| ------------------------------------- | ------------------ | --------------------------- | ----------------------- | -------------- | ------------------------ | --------------- |
| `COMBO` -> `COMBO+R`                  | 7.6 % [6.7, 8.4]   | 0.0028 [0.0022, 0.0034]     | 7.0 %                   | 1.09           | +0.0081 [0.0069, 0.0094] | 69 %            |
| D -> D + R (first Refine)             | 10.0 % [9.1, 10.9] | 0.0049 [0.0041, 0.0058]     | 8.4 %                   | 1.22           | +0.0150 [0.0125, 0.0175] | 85 %            |
| D + R -> D + 2R (second Refine, null) | 3.9 % [3.6, 4.2]   | 0.0008 [0.0007, 0.0009]     | 4.1 %                   | 0.97           | +0.0025 [0.0021, 0.0029] | 65 %            |

- Ratio to the null: `COMBO` -> `COMBO+R` 1.93 x [1.76, 2.09] on the app's metric and 3.62 x [3.04, 4.20] on shape. A
  first Refine after a plain Discover: 2.55 x and 6.36 x. **Not settled** (rule: above 1.5 x the null).
- The movement is toward the truth (69 % of cells gain r, mean +0.008), so it is improvement, not noise. It is about
  half of what a first Refine does after a plain Discover.
- Born in the last 20 %: change 42 % [35, 49], r 0.904 -> 0.968. Isolated: 5.9 %, r 0.9903 -> 0.9927. Close-pair: 8.0 %,
  r 0.9902 -> 0.9932.
- "Moved at all" (the app's "refined" count) is 87-97 % of cells in every step, including the null. It carries no
  information.

### T6. Workshop recording (`qc_eval real`, 18,000 frames, slow seeds 1 and 2)

Cells: D + R 831 / 838, `COMBO` 751 / 760. Peak memory 1.8-1.9 GB per run.

| step, by id                           | change, app metric (median) | shape-only change | split-half noise before | change / noise |
| ------------------------------------- | --------------------------- | ----------------- | ----------------------- | -------------- |
| `COMBO` -> `COMBO+R`                  | 30.4 % / 28.3 %             | 0.039 / 0.035     | 14.5 % / 14.4 %         | 2.2 / 2.1      |
| D -> D + R (first Refine)             | 25.7 % / 23.9 %             | 0.029 / 0.026     | 17.4 % / 17.5 %         | 1.5 / 1.4      |
| D + R -> D + 2R (second Refine, null) | 10.0 % / 9.8 %              | 0.0048 / 0.0043   | 9.9 % / 10.0 %          | 1.1 / 1.1      |

qc_eval reproduces the app's readout (28.2 %). The Refine after look-back changes footprints 3 x the null on the app's
metric and 8 x on shape: **not settled** on real data, and no more settled than a plain Discover.

| library   | seed 1 vs seed 2: matched share, median r | Minian: matched units, median r |
| --------- | ----------------------------------------- | ------------------------------- |
| Discover  | 82 %, 0.951                               | 525 / 514, 0.937 / 0.942        |
| `COMBO`   | 82 %, 0.953                               | 494 / 500, 0.939 / 0.935        |
| D + R     | 86 %, 0.976                               | 535 / 531, 0.953 / 0.958        |
| `COMBO+R` | 86 %, 0.976                               | 508 / 518, 0.950 / 0.949        |
| D + 2R    | 88 %, 0.981                               | 540 / 533, 0.956 / 0.958        |

- Agreement of `COMBO` with D + R (same seed): median r 0.953 / 0.952; after its Refine 0.959 / 0.961 (matched 655 ->
  665 and 668 -> 685).
- Held-out score over the Refine pass (score / signal, both seeds): D + R being refined 0.0391 / 0.0395, D + 2R 0.0399 /
  0.0401, `COMBO` being refined 0.0371 / 0.0380. The cell counts differ (751-760 against 831-838), so this is not a
  footprint comparison alone.
- `COMBO` finds about 80 fewer cells than Discover on this recording (the merge guard and the replay's merges); it
  matches about 20-30 fewer Minian units. Not characterised here.
- Wall in qc_eval: `COMBO` 1198 / 1235 s (look-back 500 / 515 s, of which the drain 138 / 133 s for 4021 / 4033 steps);
  Discover + 1 Refine 1243 / 1264 s. No compute saving on this recording.

**Verdict T6: on the workshop recording the settled look-back library is at the level of a plain Discover, not of
Discover + Refine**, on seed-to-seed agreement, Minian agreement and footprint noise alike. None of these is ground
truth; they agree with each other and with the direction the sims show (the Refine moves footprints toward the truth).

### T4 and T4b. Why Refine is slower after a look-back run

Headed Chrome, workshop recording (23,711 frames in the app), dev build of `feat/cala-lookback-app` c1aa0fd3 (the
server the PI tested; its crate is identical to main bbe6e287):

| run                                       | Discover fps | settling               | Refine fps    | Refine wall | cells     | peak tab memory |
| ----------------------------------------- | ------------ | ---------------------- | ------------- | ----------- | --------- | --------------- |
| look-back off (2 runs)                    | 193 / 153    | -                      | 119.7 / 122.8 | 192 / 195 s | 850 / 859 | 2.5 GB          |
| look-back on (2 runs)                     | 157 / 193    | 147 / 123 s, 966 steps | 68.1 / 75.0   | 370 / 323 s | 742 / 752 | 3.2 GB          |
| look-back on, cluster replay off (2 runs) | -            | 96 / 102 s             | 144.9 / 144.9 | 160 / 166 s | 814 / 830 | -               |

- The PI's observation is reproduced: Refine at 0.57-0.61 x.
- With `LOOKBACK.jointUpdate = 'off'` (a temporary local build, not committed) Refine is back to full speed, so **the
  cluster replay setting is the cause**, not the look-back worker or its messages. Caveat: the first four runs shared
  the machine with the sim suite, the last two did not, so the 145 against 120 is not a like-for-like gain.
- qc_eval on the workshop recording, Refine pass, slow loop per frame: observe 3.9 ms (default) against 8.0-8.3 ms
  (`COMBO` settings), step 10.4 against 13.0 ms, pass wall 597 against 745-772 s. The observe step runs on the slow
  loop's own thread in the app, and the Refine replay waits for it.
- Settling is not slower because of the replay (96-102 s without it): it is the lock-step. 966 steps of 2 frames in
  123-147 s is about 14 frames per second; during Discover the same worker re-read about 23,000 frames in under 2 min.
- Discover + settling took 241-293 s; Discover + Refine with look-back off 310-335 s.

Controlled timing on the sims (T4; static s5-s7, the three arms of a sim together, nothing else running):

| arm       | pass-2 (Refine) wall, s5 / s6 / s7 | vs `DR-main`       | observe ms/frame, pass 2 | step ms/frame, pass 2 | work units/frame, pass 2 |
| --------- | ---------------------------------- | ------------------ | ------------------------ | --------------------- | ------------------------ |
| `DR-main` | 158.6 / 161.7 / 159.6 s            | -                  | 2.81 / 2.94 / 2.89       | 9.89 / 10.03 / 9.88   | 37.0-37.2 M              |
| `DR-st2g` | 169.6 / 176.1 / 175.5 s            | 1.07 / 1.09 / 1.10 | 3.59 / 3.81 / 3.87       | 10.27 / 10.56 / 10.45 | 39.2-39.8 M              |
| `COMBO+R` | 165.9 / 172.9 / 169.1 s            | 1.05 / 1.07 / 1.06 | 3.40 / 3.70 / 3.62       | 10.21 / 10.38 / 10.23 | 39.5-40.0 M              |

**Verdict T4:** on the sims in qc_eval the ratio is at most 1.10 on every sim, so by the rule the settings do not
explain a 2 x slowdown there. They do in the app and on real data (above): qc_eval's slow loop is paced by a work
budget per frame, the sims have smaller overlap clusters than the workshop recording (observe +25-30 % on the sims,
+105-110 % on the recording), and the app's Refine waits for the slow loop's own thread. Also from these quiet runs:
`COMBO`'s single pass takes 277-283 s against 324-330 s for Discover + Refine (-14 %).

### T5. Bigger settling batches (full tier, vs `COMBO`)

| arm         | drain steps (14 sims) | footprint r all / isolated / close-pair (diff) | headline (diff)        | matched / false (diff) | late-born rows                                                              |
| ----------- | --------------------- | ---------------------------------------------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `COMBO`     | 31,028                | -                                              | -                      | -                      | -                                                                           |
| `COMBO-d16` | 3,886                 | 0.0000 / 0.0000 / 0.0000, CIs within +-0.0013  | +0.001 [-0.009, 0.012] | -0.2 / +0.2            | r last 20 % -0.005 [-0.038, 0.014]; bite share 0-0.5 D 0.61 -> 0.81 (worse) |
| `COMBO-d64` | 977                   | 0.0000 / 0.0000 / 0.0000, CIs within +-0.0014  | 0.000 [-0.010, 0.011]  | -0.3 / +0.3            | r last 20 % -0.014 [-0.040, 0.007]; bite share worse in 2 of 3 bins         |

Drain wall in qc_eval (static_s5 / motion_s5): 23.8 / 46.8 s at 16 frames per step, 22.7 / 50.2 s at 64; qc_eval has no
message round trip, so its drain wall says nothing about the app's.

**Verdict T5: not met as tested.** The rule asked for the birth-time rows within noise, and a late-born bite row is
flagged worse at 16 frames per step (two at 64); few cell pairs carry those rows. Everything else passes and steps fall
8 x. In this test the visit rounds fell together with the steps, so it cannot say whether batching the frames while
keeping the visit rounds would be clean. That variant was not run and is the one to test.

### Decision

By the rule above: **no-go for hiding Refine now.** T1 shows a broad gain from a Refine after look-back, largest for
late-born cells; T3 and T6 show the settled library is not converged; T6 shows that on real data it is at
plain-Discover level. Look-back as built does meet the PI's bar on the sims (equal to Discover + 1 Refine), which is
why the earlier full-tier result read as a pass.

## Follow-up experiment: settling over all cells (targets written before the runs)

The review's first recommendation is a hypothesis: what a Refine adds after look-back is frames for every cell, solved
with the final frozen cell set, that replace the older statistics. Earlier arms bear on it: the precision demand
(`LBP-x2`, [2026-11-19-concurrent-refine.md](2026-11-19-concurrent-refine.md)) fed most cells most blocks as targeted
look-back frames, which do not advance the forgetting clock, and gained nothing over the `K`-window; the catch-up arm
(`CU-2400`), untargeted with the clock advancing, did close the isolated-cell gap.

New flag `--lookback-settle-all N` (example only): after the drain, about N frames spread evenly over the recording go
to every cell as untargeted look-back frames (the clock advances), cell set frozen, one slow-loop step per 2 frames,
all tiles marked due and the library published every 64 steps.

Arms (quick tier: static s5-s7, pairs s5-s6): `COMBO-SA9600` (every frame) and `COMBO-SA4800` (every second frame),
against `COMBO` and `COMBO+R` from the full-tier runs.

- Hypothesis supported when `COMBO-SA9600` is within 0.001 of `COMBO+R` on footprint r median (all, isolated,
  close-pair) and its gain over `COMBO` is at least 0.002 on all cells with a CI that excludes 0.
- Not supported when its gain over `COMBO` is under 0.001 on all cells.
- Reported: born-late rows, headline, bites, and `COMBO-SA4800` (does half the frames do).

### Result (quick tier, 5 sims; binary `qc_eval-lbreview-b`, run tree `$CALA_DATA/demix-suite/lbreview-sa`)

| metric                        | COMBO        | COMBO-SA4800 | COMBO-SA9600 | COMBO+R      | SA9600 - COMBO            | SA9600 - COMBO+R           |
| ----------------------------- | ------------ | ------------ | ------------ | ------------ | ------------------------- | -------------------------- |
| footprint r, all              | 0.9911       | 0.9919       | 0.9923       | 0.9935       | +0.0013 [0.0005, 0.0021]  | -0.0011 [-0.0018, -0.0005] |
| footprint r, isolated         | 0.9901       | 0.9908       | 0.9914       | 0.9923       | +0.0013 [-0.0012, 0.0038] | -0.0009 [-0.0033, 0.0006]  |
| footprint r, close-pair       | 0.9911       | 0.9920       | 0.9923       | 0.9937       | +0.0012 [0.0001, 0.0025]  | -0.0013 [-0.0024, -0.0006] |
| footprint r, born second half | 0.9556       | 0.9635       | 0.9656       | 0.9825       | +0.0100 [0.0004, 0.0241]  | -0.0169 [-0.0246, -0.0058] |
| footprint r, born last 20 %   | 0.9205       | 0.9385       | 0.9288       | 0.9729       | +0.0083 [-0.051, 0.061]   | -0.0441 [-0.1016, -0.0035] |
| crosstalk headline            | +0.072       | +0.073       | +0.076       | +0.059       | +0.003 [-0.019, 0.019]    | +0.017 [-0.007, 0.032]     |
| bite share < 0.5, 0.75-1 D    | 0.253        | 0.234        | 0.221        | 0.146        | -0.032 [-0.085, 0.021]    | +0.075 [0.027, 0.122]      |
| matched / false               | 348.8 / 11.0 | 349.0 / 10.8 | 348.6 / 11.2 | 349.2 / 10.6 | within noise              | within noise               |

Cost on static_s5: the settle-all phase raises the drain from 4761 to 14,361 frames (9561 at every second frame);
pass-loop wall 303 s (`COMBO`), 367 s (SA4800), 400 s (SA9600), against 324 + 198 = 522 s for `COMBO+R` (walls from
different sessions, so approximate).

**Verdict: partly supported.** Feeding every frame to every cell through the look-back path, cell set frozen and clock
advancing, gains +0.0013 on all cells (between the 0.001 and 0.002 lines), about 40 % of what the Refine pass adds, and
stays 0.0011 below `COMBO+R`, with the late-born cells and the bites far from it. Half the frames give about two thirds
of that gain. So frames for all cells with the final cell set are part of what Refine adds, not all of it. What the
look-back path leaves out, and a Refine pass has, is not yet separated: the reservoir of residual frames that
reservoir-based refines read, one slow-loop step per frame batch at the full work budget (this arm ran one step per 2
frames, about half the visit work), and the ordinary `observe` path. Those are the next ablations.
