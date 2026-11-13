# S2.1c minimal option: the split-half refine gate

12 Nov 2026. Branch `feat/cala-refine-gate` (from main 7d4569c). Binary built with `--features diagnostics`. Paths are
the scratch directory `scratchpad/s21d-gate`, which is not in the repo. The plan is `S2.1c-plan-v2.md` section 2.

## The rule

Under `--refine-gate split-half` (`SlowLoopConfig::refine_gate = RefineGate::SplitHalf`), the statistics path proposes
a refinement only when the change exceeds the estimate's own split-half noise:

`Î = ‖h/a − cur‖² − ½‖(h_A − h_B)/a‖² > 0`

Both terms are whitened and in current-column units: `a` is the estimate's least-squares scale on the current column.
This is the same quantity as `stats_trigger` in PR #360's shadow. On that path it replaces the χ² disagreement test and
`refine_min_change`. There is no new constant and no power gate (`z_pred`). A cell without split halves keeps the
legacy trigger; under the default `basin-skirt` rule such a cell gets no proposal anyway. The reservoir path, absorbs
and merges are unchanged. The default stays `legacy`.

## Verdict

**The gate fails its primary target, so the default stays `legacy`.** On real data, late refines fall by 37 %
(pooled over the two seeds), against a target of ≥ 40 %. Every other gate passes:

- precision and recall are unchanged at 1× and 4×;
- `r_fp` at the last checkpoint is unchanged;
- the early cost (`r_fp` at frame 3000) is within its margin by the mean;
- texture and seed-to-seed Jaccard pass.

The offline estimate predicted that 52 % of late accepted refines would be kept on real data. Live, 61 % are kept:
late accepted statistics-path refines fall from 561 to 343. Two effects narrow the cut:

- refines with `Î > 0` that the legacy rule declined are now proposed;
- absorbs rise by 2 per minute, taking up some of the change.

## Identity

`--refine-gate legacy` matches main 7d4569c byte for byte on `$SIM_MOTION_S5` (9600 frames,
`--batch 8 --budget 30000000 --slow-seed 1 --churn-log --support-rule basin-skirt --motion`). Only the wall-time files
differ (`cost.txt`, `passes.tsv`, `flat_field_updates.tsv`).

## Runs

- **ctl, 1× sims and real.** These are the PR 0 runs `s21c-pr0/runs/f0_*`: the base 7d4569c with the decide shadow,
  which was shown identical to the base except for its own logs.
- **ctl, 4× motion.** Base 7d4569c (`--budget 120000000`).
- **arm.** The gate binary with `--refine-gate split-half`. Flags are otherwise the same:
  - sims: `--batch 8 --slow-seed 1 --churn-log` (`--motion` on the motion arm);
  - real: `--motion --frames 18000 --batch 8 --budget 30000000 --via-jobs --churn-log --slow-seed 1|2`.
- **Paired statistics.** Mean d ± 95 % t-CI over seeds 5–9 (`summarize.py`).

## Gate table

| Gate                                       | ctl                | gate              | d (± CI)                          | Pass if     | Result                       |
| ------------------------------------------ | ------------------ | ----------------- | --------------------------------- | ----------- | ---------------------------- |
| Late real refines per min (frames > 12000) | 57.5, 54.0 (111.5) | 35.7, 34.5 (70.2) | **−37.0 %** pooled (−38 %, −36 %) | down ≥ 40 % | **FAIL**                     |
| `r_fp`, 1× (motion / static)               | .942 / .970        | .942 / .969       | +.000 ± .001 / −.001 ± .002       | ≥ −.010     | PASS                         |
| `r_fp`, 4× motion                          | .945               | .945              | −.000 ± .001                      | ≥ −.010     | PASS                         |
| P8, 1× (motion / static)                   | .920 / .942        | .925 / .948       | +.005 ± .018 / +.005 ± .017       | ≥ −.02      | PASS                         |
| R8, 1×                                     | .764 / .785        | .762 / .790       | −.002 ± .016 / +.005 ± .009       | ≥ −.02      | PASS                         |
| P8, 4× motion                              | .859               | .866              | +.007 ± .014                      | ≥ −.02      | PASS                         |
| R8, 4× motion                              | .813               | .813              | −.001 ± .005                      | ≥ −.02      | PASS                         |
| R2, 1× (motion / static)                   | .558 / .589        | .550 / .589       | −.008 ± .012 / −.001 ± .010       | ≥ −.05      | PASS                         |
| R2, 4× motion                              | .652               | .643              | −.009 ± .007                      | ≥ −.05      | PASS                         |
| `r_fp` at frame 3000, 1× (motion / static) | .868 / .895        | .854 / .877       | −.014 ± .014 / −.018 ± .012       | ≥ −.02      | PASS by mean (CI below −.02) |
| `r_fp` at frame 3000, 4× motion            | .912               | .902              | −.010 ± .006                      | ≥ −.02      | PASS                         |
| Texture, real                              | 0, 0               | 1, 1              |                                   | ≤ ctl + 2   | PASS                         |
| Seed-to-seed Jaccard, real                 | .697               | .711              | +.014                             | ≥ ctl − .01 | PASS                         |

The early cost is consistent across seeds: `r_fp` at frame 3000 is lower in every one of the 15 paired runs. The mean is
inside the margin, but the CI's lower end is not. That fits the plan's warning that about 40 % of early GT-improving
refines are within split-half noise when first proposed. By frame 9600 the difference has gone (`r_fp` d ≈ 0), so they
are deferred, not lost.

## Reported (not gated)

| Real, late (frames > 12000) | ctl s1      | ctl s2      | gate s1     | gate s2     |
| --------------------------- | ----------- | ----------- | ----------- | ----------- |
| refines per min             | 57.5        | 54.0        | 35.7        | 34.5        |
| absorbs per min             | 6.3         | 5.8         | 8.5         | 8.1         |
| merges per min              | 17.5        | 19.6        | 16.9        | 20.4        |
| adds per min                | 27.6        | 32.1        | 31.1        | 29.6        |
| `conv_big4` (mean ≥ 12000)  | .105        | .093        | .083        | .078        |
| refines per min, < 3000     | 40.0        | 36.0        | 26.8        | 20.8        |
| refine tests, late          | 2294        | 2207        | 1152        | 1212        |
| cells, S8                   | 731, 22 259 | 762, 22 809 | 733, 22 156 | 740, 22 619 |
| Minian agreement ≥ .5       | 531         | 534         | 521         | 522         |

- **Real `conv_big4`.** Late `conv_big4` falls by about .018, to .08.
- **Real cost.** The late refine tests (the slow loop's held-out solves) halve.
- **Real Minian agreement.** Agreement at ≥ .5 is down by 10–12 cells.

Sims, d ± CI (late = frames ≥ 4800):

| Metric                  | 1× motion             | 1× static             | 4× motion               |
| ----------------------- | --------------------- | --------------------- | ----------------------- |
| late refines per min    | −16.9 ± 6.0 (of 73.4) | −17.6 ± 6.6 (of 71.6) | −84.2 ± 19.9 (of 208.3) |
| late absorbs per min    | +7.2 ± 7.3            | +4.5 ± 10.2           | +21.4 ± 16.5            |
| late merges per min     | −0.4 ± 3.2            | −0.4 ± 1.3            | +1.0 ± 4.2              |
| late `conv_big4` (mean) | −.008 ± .016          | −.009 ± .011          | −.017 ± .011            |
| deletes per min         | +0.7 ± 0.3            | −0.1 ± 0.9            |                         |

Peak RSS is 1.48 GB (real) and 1.43 GB (sims).

## Next

- The gate halves the noise-sized late refines on real data, but at −37 % it misses the ≥ 40 % target. With the power
  gate (`z_pred ≥ m(looks)`) the plan's offline estimate is about −74 %, with a larger early cost. Whether to add it, or
  to restate the target as the plan's N1 proposes (noise-sized publications, not a count), is a PI decision.
- Absorbs rise when refines are gated. If the gate becomes the default, absorbs may need the same `Î` treatment.
- `refine_min_change` stays: the reservoir path still uses it.

## Decision (PI, 13 Nov 2026): made the default

The PI approved the split-half gate as the default (`RefineGate::SplitHalf`;
`--refine-gate legacy` keeps the old rule). The ≥ 40 % target was restated as
"fewer noise-sized refines", which the gate meets: late real refines fall 37 %,
every quality gate passes, and seed-to-seed Jaccard rises from .697 to .711. The
early `r_fp` cost at frame 3000 (−.014/−.018) recovers by the end of the run.
Absorbs rise when refines are gated, so absorbs may later need the same `Î` test.

## Files

- `reports/summ_x1.md` and `reports/summ_x4.md` (`summarize.py`)
- `reports/extra.md` (`analyze.py`: `r_fp` at frame 3000, edit rates, late `conv_big4`)
- `reports/real_eval.txt` (`s23b/evalrun.py`)
- `reports/jac_*.txt`
- `queue.sh` and `queue.log`
