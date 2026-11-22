# Per-cell settledness and Final-settle stop levels: plan (22 Nov 2026)

Written and committed before any quality number was computed. The measures and thresholds below were chosen from
the measures' own distributions and stop frames only (`settledness.py dist`, plus the checks listed under "What was
looked at first"). Script: [`settledness.py`](../settledness.py).

## Data

Offline only, no new runs. PR #464's saved runs (`~/Projects/cala-data/runs/work-slider-tier1`):

- real: Samara `10_43_21` (`sa`) and `14_57_02` (`sb`), arms REF (Max), P30, S30, slow seeds 1-3 (18 runs);
- sims: pairs 5, 6, static 5, 6, 7, arms REF, P30, S30, seed 1 (15 runs), with ground truth.

Each run's `B100/footprints_settle{c}.bin` is the library at checkpoint c of the in-order full Final settle, every
1,200 frames (real: c = 0-15, about 17,880 frames; sims: c = 0-8, 9,600 frames). The last checkpoint is the full pass.

## What was looked at first (measure-only, no quality)

- About 45 % of cells have an exactly zero step between two checkpoints, and about 30 % have no change at all in a
  three-step window. Library footprints change only when a refine is committed (the refine gate tests the change
  against the estimate's split-half noise). Every cell is visited several times per checkpoint (about 8 visits per
  cell per 1,200 frames), so a zero step means the gate refused the change, not that the cell was skipped. A cell
  with no committed change in its window **counts as settled**. Its share is reported.
- Per-cell split-half noise is not saved per checkpoint (`settle_checks.tsv` has medians only; `cells.tsv` covers
  Discover). So the measures below use the footprint's own scale. In the app, `SlowLoop.footprintNoise` (already
  read by `settle.ts`) can replace the scale; that swap is not tested here.
- Planted test (one synthetic cell, three steps): pure wobble with step 0.077 gives point drift 0.000; an edge bite
  filling in with step 0.052 gives 0.105; a footprint growing 0.15 px per checkpoint gives 0.051. Per-cell Spearman
  of M1 against the point drift is 0.36 (real) / 0.34 (sims). The upper-bound variant correlates 0.74 with M1, so it
  mostly re-measures step size.

## Measures (per cell, from its last K + 1 = 4 checkpoint footprints)

Footprints are scaled to unit L2 norm. Steps are d_1..d_3. Regions, on the newest footprint f:

- **core** = pixels at or above half of f's peak;
- **edge** = the union of the window's supports, dilated by 2 px, minus the core.

The edge region includes empty pixels next to the footprint, so a bite filling in or an edge growing outwards is
inside it.

- **M1 `step`**: |d_3|, the size of the last step relative to the footprint's own scale. Magnitude only (the
  existing "moving" idea, with the noise scale swapped for the footprint's own scale).
- **M2 `drift`** (the main candidate): the steady, same-direction part of the steps, measured per region and
  taking the larger of the two.
  - S_r = sum over pairs i<j of d_i . d_j on region r.
  - drift_r = sqrt(max(0, S_r) / 3) / max(|f on r|, 0.1).
  - Wobble with no consistent direction has S about 0 or below, so it scores about 0 at any size. Steady growth or
    shrinkage of the edge scores its rate per checkpoint.
- **M2b `drift_ucb`** (secondary): M2 with a two-sd upper bound, S_r + 2 Q_r, where Q_r = sqrt(sum (d_i . d_j)^2)
  is the sd of S under random step-sign flips. This is a "confidently settled" variant. It also penalises large
  wobble.

A cell is **settled at tau** when its measure is below tau. Cells that are not present in all four checkpoints (new
or merged) count as **not settled**. The earliest possible stop is checkpoint K = 3: 20 % of the pass on real, 37.5 %
on sims.

## Stop rules (grid fixed now)

Stop at the first checkpoint c >= 3 where the share of the library's cells settled at tau is at least q. If none
qualifies, run the full pass.

| measure     | tau                | q          |
| ----------- | ------------------ | ---------- |
| M1 step     | 0.08, 0.12         | 0.80, 0.90 |
| M2 drift    | 0.01, 0.02, 0.03   | 0.90, 0.95 |
| M2b ucb     | 0.05, 0.08         | 0.80, 0.90 |

That makes 14 rules. **Baseline:** fixed in-order truncation at every checkpoint (free from the saved checkpoints).
Each rule is compared with the fixed truncation at the same mean frames. A rule that does not beat it is not
recommended over a fixed budget.

## Scoring (stopped library at checkpoint c against the same run's full pass end)

Loss = stopped minus full pass, signed so that positive means worse.

**Sims (primary; truth is independent of read order).**

- Each end-library cell is matched to a true unit once, with the motion offset and Hungarian match at r >= 0.7
  (`demix_metrics` functions, called directly).
- The same cell id is then scored at every checkpoint against that unit:
  - footprint Pearson r;
  - core relative error and edge relative error. Core = true pixels at or above half the true peak. Edge = true
    support (above 2 % of peak) dilated by 2 px, minus the core. Error = |a e - g| / |g| on the region, where e is the
    estimate and a is fitted by least squares over the whole footprint.
- Bitten share: matched pairs with a matched true neighbour where the true value at the neighbour's centre is above
  0.1, and the estimate there is below half of it (#464's definition, via `bite_rows`).
- Library figures are the mean r, the median and 90th percentile of core and edge error, and the bitten share.
- Separately for:
  - cells **unsettled at the stop**;
  - **late-born** cells (Discover birth in the second half);
  - pairs that are bitten at some checkpoint and healed by the end.

**Real (vs Max, which is read in order and still rising, so it is biased towards the full pass).**

- Reference: the *other* seeds' REF `B100` libraries, never the run's own end.
- Single-pair cosines, matched greedily within 12 px at cosine >= 0.7, pooled over the two reference seeds. Report
  the median and the 10th percentile.
- Also the share of Max's repeatable cells present: REF cells found in at least one other REF seed.

**Prediction of the remaining gain (per cell).**

- At every checkpoint c >= 3, take the Spearman correlation of each measure with the cell's remaining gain to the
  end:
  - sims: the drop in total and in edge error against truth;
  - real: the rise in cosine against its Max partner (the partner fixed at the end).
- Averaged over checkpoints, per run. Do not use the remaining change to the run's own end (wobble size predicts
  future wobble, which would flatter M1).
- **Bite check (sims):** for each pair that heals during the pass, the measure's percentile among all cells at the
  checkpoint before it heals (c >= 3), and the share above each tau.

**n and CIs.**

- Real: per arm, n = 6 (2 recordings x 3 seeds). Seeds share a recording, so the interval is too narrow; pooled over
  arms n = 18.
- Sims: n = 5 sims per arm, 15 pooled.
- 95 % t intervals of the mean loss, paired within run.

## Level selection (fixed now)

- **Thorough** = the full pass.
- **Standard** = the rule with the largest mean share of frames saved (averaged over real and sims) whose mean losses
  are all within these tolerances:
  - real: median cosine <= 0.001, 10th-percentile cosine <= 0.003, repeatable cells present <= 1 point;
  - sims: mean r <= 0.001, median edge error <= 0.005, bitten share <= 0.01.
- **Quick** = the same with real 0.003 / 0.01 / 3 points and sims 0.003 / 0.015 / 0.03.
- If no rule passes a level, that level is the full pass, or a fixed budget if a fixed truncation passes and saves
  more.
- A rule also has to beat the fixed truncation at its mean frames to be preferred over that fixed budget.

Not done (cheap version not possible): what a 0.003 cosine change does to the traces. No traces were saved per
checkpoint.
