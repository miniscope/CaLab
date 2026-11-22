# Work slider, tier 1: does a slower position end as good as Max? (22 Nov 2026)

Work-slider PR 4. The arms, branches and pass lines were committed before the runs they judge
([2026-11-22-slider-tier1-plan.md](2026-11-22-slider-tier1-plan.md), commits `f897b273` and `bb2f39e7`). Anything
added after a run is marked **(after the runs)**.

Names: **Max** (`REF`) = no pacing, no Background settle, full Final settle (today's recording path). **P-30 / P-60**
= paced at 30 / 60 fps, Background settle off. **S-30 / S-60** = paced, Background settle on with cap 2. The app's
single look-back worker takes turns between need-driven look-back and Background settle. **Final settle budgets:**
`B0` (none), `B25`, `B50`, `B75` (a quarter, half or three quarters of a pass, spread evenly over the recording), and
`B100` (today's full pass, in order). "Agreement" = the median footprint cosine of the cells two libraries share
(matched one-to-one within 12 px at cosine 0.7 or more).

## Short answers for the PI

1. **Footprints: yes, at 30 fps, with one exception.**
   - On the cells that Max (all three seeds) and the paced run both find, the footprints after the Final settle are
     as close to Max's as Max's seeds are to each other: within 0.001 in cosine.
   - The exception is S-30 on `14_57_02`, at -0.003.
   - The pre-registered agreement line (L2) still **fails** at 30 fps, by 0.001-0.003 below its margin. The failure
     comes from which cells are counted: paced runs match more of Max's weaker cells, and those pull the median down.
2. **Cells: paced runs keep Max's cells and add more.**
   - P-30 and S-30 have 96-97 % of the cells Max finds repeatably. Max's own leave-one-seed-out figure is 93 %
     (L2b passes).
   - On top of that they add about 50-75 cells per run that no Max seed has.
   - Those extra cells look like the cells only one Max seed finds: low held-out z (median 0.2-1.3) and lower peak z.
   - On the sims, paced runs match about 43 more true cells and add about 23 more false cells per sim than Max.
3. **60 fps: model not usable; Chrome (one run per arm) looks like 30 fps.**
   - The model failed its calibration at 60 fps on visit jobs (-18 % and -20 %, line 15 %), so 60 fps rests on Chrome
     alone, n = 1 per arm and recording.
   - In Chrome, every 30 and 60 fps arm agrees with Max to within 0.0035 of Max's own run-to-run agreement, on both
     recordings.
4. **How much Final settle can be skipped: no rule is safe yet.**
   - On `10_43_21`, half the pass could be skipped at Max and at P-30, and three quarters at S-30.
   - On `14_57_02`, none could be skipped at any position.
   - The design's stop test (drift ratio R at most 0.8) never fired: R stayed at 0.87-1.00 for the whole pass in every
     run, so footprints keep drifting the same way until the end of the pass.
   - The "at most 4 % moving" floor alone is reached by about frame 3,600, far too early.
   - Keep the full Final settle (as decided).
5. **Cap 4 (L9): worth testing, for the live library only.**
   - The Background settle makes the live library better than pacing alone (+19 points of the gap closed, 95 % CI
     5-29).
   - S-30 closes only 17 % / -5 % of the gap.
   - The look-back worker is half busy, so it has room for more.
   - After the full Final settle, dose 2 and dose 0 end the same, so more dose cannot improve the final result.
6. **Second look-back worker (L8): not needed for final quality.**
   - At 60 fps one worker delivers 1.33-1.39 re-reads per live frame, not the cap of 2.
   - After the Final settle, S-60 and P-60 end the same in Chrome.
   - The Background settle still improves the live library at 60 fps (Chrome). Whether a second worker would add to
     that is not modelled and is left open.

## What was run

| what | data | n |
| --- | --- | --- |
| Chrome, 60 fps pairs and second Max runs (this PR) | Samara `10_43_21`, `14_57_02`; headed, Metal GPU, port 5198, one at a time | 1 per arm and recording |
| Chrome, Max and 30 fps pairs | the same recordings, #461's runs | 1 per arm and recording |
| Model, C1 at 60 fps | `10_43_21`, offered at Chrome's 59.1 fps | 1 per row |
| Model, tier 1: REF, P-30, S-30 | both Samara recordings, slow seeds 1-3, each branched into `B0`-`B100` | 3 seeds x 2 recordings = 6 per arm |
| Model, tier 1 sims | quick tier (static 5, 6, 7; pairs 5, 6), slow seed 1 | 5 sims per arm |

Model flags: #456 round 2 with `--visit-units-per-ms 2.3e6 --pool 4` (`slider_tier1.sh`). The workshop recording is
excluded (plan). The 30 fps model runs took about 50 min each, Max about 21 min; at most 1.3 GB per process.

**Caveat on Max in the model.** C1 failed at full speed. The model's Max makes about 1,600 visit jobs in Discover
where Chrome makes about 3,900. It ends with 290 / 253 cells where Chrome ends with 320 / 280. Every model parity
number is relative to this Max. The Chrome rows below are the check on it.

## Step 1: C1 at 60 fps

The full table is in the plan file. Both rows fail on visit jobs only:

- off row: -17.5 %;
- on row: -19.8 %;
- the missed share, need-driven frames and settle dose pass (dose -14 %).

By the rule written before the runs, model arms ran at 30 fps only. The approved `14_57_02` trio gave both recordings
a Chrome 60 fps pair and a Chrome Max-to-Max null.

## Question 1: parity after the Final settle

### Model, 30 fps (n = 3 seeds per recording; full pass `B100`)

| recording | arm | agreement with Max, mean (range) | Max-Max null | L2 (>= null - 0.003) | Max's repeatable cells present | leave-one-out null | L2b | missed | L5 moving at end |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `10_43_21` | P-30 | 0.9892 (0.9876-0.9903) | 0.9926 | **fail** (-0.0034) | 96.3 % | 93.3 % | pass | 0 % | <= 0.3 % |
| `10_43_21` | S-30 | 0.9892 (0.9887-0.9896) | 0.9926 | **fail** (-0.0034) | 96.5 % | 93.3 % | pass | 0 % | <= 0.5 % |
| `14_57_02` | P-30 | 0.9872 (0.9863-0.9883) | 0.9915 | **fail** (-0.0043) | 96.8 % | 93.0 % | pass | 0 % | <= 0.3 % |
| `14_57_02` | S-30 | 0.9851 (0.9826-0.9873) | 0.9915 | **fail** (-0.0064) | 97.4 % | 93.0 % | pass | 0 % | <= 0.3 % |

Pooled over the 6 recording-seeds (paired bootstrap; seeds of one recording are not independent, so the interval is
too narrow):

| arm | agreement minus null | repeatable cells minus null |
| --- | --- | --- |
| P-30 | -0.0038 [-0.0047, -0.0030] | +3.4 points [2.4, 4.4] |
| S-30 | -0.0049 [-0.0066, -0.0035] | +3.8 points [2.9, 4.6] |

**(After the runs) Same cells only.** The median cosine on the cells that all three Max seeds and the arm have
(200-245 cells per seed):

| recording | arm | Max vs Max | arm vs Max | difference |
| --- | --- | --- | --- | --- |
| `10_43_21` | P-30 | 0.9918 | 0.9915 | -0.0003 |
| `10_43_21` | S-30 | 0.9917 | 0.9916 | -0.0001 |
| `14_57_02` | P-30 | 0.9914 | 0.9903 | -0.0010 |
| `14_57_02` | S-30 | 0.9914 | 0.9882 | **-0.0032** |

So most of the L2 failure is in the cell set, not in the footprints. The paced arms match about 3 points more of Max's
cells. The cells they add to the match are the weaker ones, with lower cosine, and they pull the median down. S-30 on
`14_57_02` is a real footprint difference of about the size of the margin. This diagnostic was not pre-registered;
L2 as written fails.

### Chrome anchor (n = 1 per arm; the app's own Final settle)

| recording | Max-Max null | arm (Background-settle dose) | cells (Max: 320/326; 283/274) | agreement with the two Max runs | within null - 0.003? | cells both Max runs found, present |
| --- | --- | --- | --- | --- | --- | --- |
| `10_43_21` | 0.9908 | P-30 (0) | 387 | 0.9900 / 0.9907 | yes | 97.9 % |
| | | S-30 (1.99) | 377 | 0.9898 / 0.9893 | yes | 98.6 % |
| | | P-60 (0) | 379 | 0.9893 / 0.9901 | yes | 97.2 % |
| | | S-60 (1.33) | 377 | 0.9903 / 0.9902 | yes | 97.2 % |
| `14_57_02` | 0.9913 | P-30 (0) | 325 | 0.9873 / 0.9896 | yes (by 0.0002) | 96.8 % |
| | | S-30 (1.99) | 324 | 0.9867 / 0.9891 | no, by 0.0004 | 97.6 % |
| | | P-60 (0) | 319 | 0.9896 / 0.9910 | yes | 97.6 % |
| | | S-60 (1.39) | 320 | 0.9875 / 0.9886 | no, by 0.0003 | 96.8 % |

The two Max runs share 284 of 320 and 247 of 283 cells (89 % and 87 %). In Chrome, Max itself misses more of its own
cells than any paced arm does. No frame was missed by the slow loop at 30 or 60 fps.

### Extra cells (reported apart, as the PI asked)

Model, all three seeds pooled. "Extra" = in no Max seed's library.

| recording | group | cells | median held-out z | held-out z > 2 | median peak z | median birth (share of recording) | born in 2nd half |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `10_43_21` | Max, found by one seed only | 48 | 0.3 | 25 % | 10.9 | 0.56 | 60 % |
| | P-30 extra | 223 (74 per run) | 0.4 | 20 % | 11.4 | 0.27 | 32 % |
| | S-30 extra | 218 (73 per run) | 0.2 | 20 % | 11.4 | 0.29 | 33 % |
| | S-30, cells Max also has | 946 | 4.4 | 67 % | 24.7 | 0.09 | 13 % |
| `14_57_02` | Max, found by one seed only | 41 | 0.6 | 24 % | 13.3 | 0.48 | 44 % |
| | P-30 extra | 157 (52 per run) | 1.3 | 34 % | 11.5 | 0.32 | 29 % |
| | S-30 extra | 148 (49 per run) | 1.2 | 32 % | 11.4 | 0.30 | 32 % |
| | S-30, cells Max also has | 831 | 3.1 | 60 % | 23.1 | 0.12 | 14 % |

- The extra cells are weak: about a fifth to a third pass held-out z > 2, against two thirds of the shared cells.
  Their peak z is half that of the shared cells.
- Their held-out z is equal to or above that of Max's own single-seed cells. So L2c "passes", except S-30 on
  `10_43_21` (0.2 against 0.3).
- They are born early (median a quarter to a third into the recording). These are cells that full-speed Discover
  never gets to, because it misses 22-24 % of the frames.
- On the sims (below), about two of every three added cells match a true cell.

### Sims (quick tier, n = 5; a screen, not a verdict)

| arm minus Max (paired t 95 % CI) | footprint r, all | screen L1 (mean >= -0.001) | r, born in 2nd half (L1b) | bitten share (L1c) | false cells (L1d) | matched true cells |
| --- | --- | --- | --- | --- | --- | --- |
| P-30 | -0.0011 [-0.0025, 0.0003] | **stop** (by 0.0001) | -0.018 [-0.043, 0.006] | +0.006 [-0.039, 0.052] | +25 [0, 50] | +41 [-6, 88] |
| S-30 | +0.0002 [-0.0009, 0.0012] | pass | -0.014 [-0.038, 0.011] | -0.018 [-0.041, 0.004] | +22 [-5, 48] | +45 [-6, 96] |

- At 5 sims, L1b and L1d cannot pass: the intervals are wider than the lines.
- The late-born and false-cell differences point the same way as the extra cells on real data: more cells, some of
  them weak.
- Model Max misses 27.5 % of the frames on the sims (at an assumed 340 fps).

**Verdict, question 1.**

- No 30 fps position passes the pre-registered parity lines in the model. L2 fails, L2b passes, and the sim screen
  stops P-30 by a hair.
- In footprints of shared cells, P-30 and S-30 are at parity on `10_43_21`, and P-30 is close on `14_57_02`
  (-0.001). S-30 on `14_57_02` is 0.003 below.
- Chrome (n = 1) puts all four positions within or 0.0004 short of the line.
- The practical difference from Max is the extra cells, not worse footprints. That is the open Q1 for the PI: about
  50-75 extra cells per Samara recording, mostly weak.

## Question 2: how much Final settle can be skipped

`B*` = the smallest budget whose library is within 0.003 agreement and 3 points of repeatable cells of the arm's own
full pass (pre-registered). **(After the first Max runs, before any paced run finished)** The comparison changed
from "Max of the same seed" to "the other seeds' Max". The same-seed rule made Max's own full pass agree with itself
at 1.0, so Max could never skip anything.

| recording | arm | `B0` | `B25` | `B50` | `B75` | `B100` | `B*` (per seed) | Final settle that could be skipped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `10_43_21` | Max | 0.9801 | 0.9888 | 0.9904 | 0.9910 | 0.9926 | `B50` (50, 50, 50) | half |
| | P-30 | 0.9815 | 0.9850 | 0.9873 | 0.9874 | 0.9892 | `B50` (50, 25, 50) | half |
| | S-30 | 0.9844 | 0.9856 | 0.9867 | 0.9863 | 0.9880 | `B25` (25, 0, 25) | three quarters |
| `14_57_02` | Max | 0.9766 | 0.9848 | 0.9872 | 0.9877 | 0.9915 | `B100` (all) | none |
| | P-30 | 0.9730 | 0.9785 | 0.9807 | 0.9823 | 0.9865 | `B100` (all) | none |
| | S-30 | 0.9795 | 0.9789 | 0.9799 | 0.9814 | 0.9845 | `B100` (75, 100, 100) | none |

(Agreement with the other seeds' Max full pass; the repeatable-cell share moved by at most 1.5 points between `B25`
and `B100` and never decided.)

Sims, footprint r with the truth (mean over 5 sims):

| arm | `B0` | `B25` | `B50` | `B75` | `B100` | `B*` per sim |
| --- | --- | --- | --- | --- | --- | --- |
| Max | 0.9603 | 0.9825 | 0.9850 | 0.9857 | 0.9858 | 75, 100, 50, 50, 50 |
| P-30 | 0.9807 | 0.9826 | 0.9836 | 0.9840 | 0.9847 | 25, 100, 50, 100, 75 |
| S-30 | 0.9853 | 0.9859 | 0.9859 | 0.9859 | 0.9860 | 0, 0, 0, 100, 25 |

What this says:

- **The Background settle does most of the Final settle's work on the sims.** S-30 before any Final settle (0.9853)
  is already at Max's full-pass level (0.9858). On the sims, the saving at S-30 is real.
- **On Samara the savings do not carry from one recording to the other.**
  - On `14_57_02`, the step from three quarters of a pass (spread) to the full pass (in order) is large for every
    arm (+0.003 to +0.004).
  - Nothing can be skipped there.
  - A budget rule tuned on `10_43_21` would cut `14_57_02` short.
- **The stop test does not work as designed.**
  - On every full pass (18 runs), at least 96 % of cells were below 2x their noise from about frame 3,600 on (the
    floor holds).
  - But the median drift ratio R over the last three steps stayed at 0.87-1.00 and never reached 0.8: R about 1 is a
    random walk or steady drift, not noise around a settled value.
  - A rule on the floor alone would stop at about a fifth of the pass, where agreement is still well below the full
    pass (Max on `14_57_02`: 0.9848 at a quarter against 0.9915).
  - The R threshold would need to be about 0.95 to fire, which would no longer tell "settled" from "drifting".
- **Recommendation:** keep the full Final settle at every position. For an adaptive end, look at what keeps
  improving between three quarters and a full pass on `14_57_02`, before fitting `k` or the R threshold.

## Question 3: sizing

**Live library at the last frame** (before any Final settle; share of Max's live-to-settled gap closed; model, per
seed):

| recording | P-30 | S-30 |
| --- | --- | --- |
| `10_43_21` | 3, 0, -11 % (mean -3 %) | 17, 16, 18 % (mean 17 %) |
| `14_57_02` | -23, -20, -25 % (mean -23 %) | -34, 10, 10 % (mean -5 %) |

- Pacing alone makes the live library less like Max's settled one: it holds more cells.
- The Background settle pulls it back: S-30 minus P-30 = **+18.8 points** [5.1, 29.4], n = 6.
- L3 (S-30 closes at least 50 %) **fails** on both recordings.
- In Chrome the live library at Discover's end agrees with Max's final library as follows:

  | arm | `10_43_21` | `14_57_02` |
  | --- | --- | --- |
  | Max live (reference) | 0.9805 | 0.9763 |
  | P-30 | 0.9821 | 0.9727 |
  | S-30 | 0.9841 | 0.9807 |
  | P-60 | 0.9771 | 0.9749 |
  | S-60 | 0.9875 | 0.9815 |

**L9, cap 4: worth testing (pre-registered rule met), for the live library.**

- S-30 beats P-30 in gap closed (lower CI bound 5.1 > 0).
- S-30 closes less than 75 % of the gap.
- The modelled look-back worker is 45-51 % busy at 30 fps (below 70 %).
- The final result will not improve: after the full Final settle, S-30 and P-30 end the same (or S-30 slightly lower
  on `14_57_02`), and the sims put S-30 ahead only before the Final settle.
- Test it only if a better live library during the run matters (live view, closed loop).

**L8, second look-back worker: not needed for final quality; open for the live library.**

- In Chrome at 60 fps, one worker delivers 1.33 (`10_43_21`) and 1.39 (`14_57_02`) re-reads per live frame, not
  the cap of 2. The design's "one worker covers 60 fps" rule (at least 1.8) is not met.
- After the Final settle, S-60 and P-60 end equal in Chrome (agreement 0.9903 / 0.9902 against 0.9893 / 0.9901, and
  0.9875 / 0.9886 against 0.9896 / 0.9910): the dose does not matter for the final library.
- The live library gains from dose 1.3 at 60 fps (Chrome above). Whether dose 2 would add to that needs the
  two-worker build or a `--lb-workers` model flag, which this PR did not add.

## Checks and limits

- Pre-registration: plan commit `f897b273` came before the 60 fps Chrome pair and every tier-1 run. The C1-at-60
  verdict (`bb2f39e7`) came before the tier-1 batch. Changes after runs are marked above.
- Every run exited 0.
  - The first launch of the two pairs sims used a wrong path and failed at start. They were rerun unchanged with
    the correct path.
  - All Chrome runs were one at a time, with no qc_eval run of mine going. Load at start: 3-4 (other agents).
  - The governor agent's Chrome window was waited for.
- Samara data read-only: model runs read `img/`; Chrome `--single` runs make no export.
- n is small:
  - 3 seeds per recording, with 2 recordings;
  - 5 sims;
  - 1 Chrome run per arm.
  - The pooled real intervals treat seeds as independent, which they are not.
- The model's Max is outside the calibrated range (C1 failed at full speed). The Chrome rows agree with the model's
  direction (more cells when paced, footprints of shared cells close).
- Workshop recording not run (plan).

Files:

- run data `~/Projects/cala-data/runs/work-slider-tier1/` (`real/`, `sims/`, `chrome/`, `c1/`), with the summaries
  `real.md`, `sims.md`, `chrome.md`;
- scripts `tools/cala-eval/slider_tier1.sh` (runs) and `tools/cala-eval/slider_tier1_summary.py`
  (`real` / `sims` / `chrome`);
- binary `bin/qc_eval-tier1-940db2b6`.
