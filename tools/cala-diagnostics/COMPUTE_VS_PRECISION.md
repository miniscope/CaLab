# Why more slow-loop compute costs precision (Nov 2026)

The slow-loop audit found that more compute buys recall but costs precision.
A 4x visit budget took P@8 from .938 to .866, and 252 frames per tile instead
of 126 took it to .904 (v2m_480 motion sim, 8 min). The leading hypothesis
was multiple testing on a reused held-out split: every visit re-tests a spot
against largely the same held-out frames with a fixed `accept_z`, so noise
eventually passes. This note tests that hypothesis and the alternatives.

**Verdict: the held-out reuse hypothesis is wrong, and so is selection
bias.** The extra false positives are not noise that wins a lottery. They
are persistent, transient-bearing, non-somatic sources that the model has no
other component for. Every check the slow loop has, at add time and after
it, sees them as cells. A test whose power grows with data or with the
number of looks will accept them eventually, whatever its threshold. Three
acceptance-side corrections were implemented and measured. None helps (see
"Corrections tried"), so this PR changes no decision. It adds the harness
outputs that make the diagnosis repeatable.

Runs: `qc_eval sim`, 9600 frames (8 min), `--batch 8`, serial `step`, on the
v2 minisim recordings with and without motion, two seeds each
(`v2m_480`, `v2m_480s6`, `v2_480`, `v2_480s6`).

- Budgets: 1x = 3e7 work units per frame (the default); 2x = 6e7; 4x = 1.2e8.
- "252 fr/tile" = `--frames-per-tile 252` (the default is 128).
- The results table is on main after #309 (f30ce26).
- The diagnostic runs below are on main before #309 (5871ca5). Every add
  assessment was logged by a temporary instrumentation patch, which is not
  committed. The effect is the same on both versions of main.
- The analysis scripts are in the session scratchpad (`speed/agentB/`).

## Results vs frames read (main f30ce26)

FP classes of the non-TP cells in the final library:

- _noise_: footprint r < .5 with every GT unit, and no GT centroid within 10 px;
- _adjacent_: r < .5, but a GT centroid within 10 px;
- _partial_: r .5–.7 with a GT unit no other cell matched;
- _dup_: r ≥ .5 with a unit another cell already matched.

| sim       | arm         | P@2   | R@2   | P@4   | R@4   | P@8   | R@8   | cells | visits | FP noise/adj/partial/dup |
| --------- | ----------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ------ | ------------------------ |
| motion s5 | 1x          | 0.946 | 0.538 | 0.951 | 0.689 | 0.934 | 0.754 | 501   | 3319   | 12/9/9/4                 |
| motion s5 | 2x          | 0.913 | 0.606 | 0.940 | 0.730 | 0.915 | 0.779 | 529   | 6947   | 17/15/8/4                |
| motion s5 | 4x          | 0.872 | 0.623 | 0.895 | 0.730 | 0.858 | 0.786 | 569   | 16804  | 27/21/25/8               |
| motion s5 | 252 fr/tile | 0.952 | 0.578 | 0.941 | 0.699 | 0.893 | 0.765 | 532   | 2048   | 18/12/14/13              |
| motion s6 | 1x          | 0.932 | 0.548 | 0.955 | 0.683 | 0.947 | 0.760 | 524   | 3284   | 5/8/10/6                 |
| motion s6 | 2x          | 0.922 | 0.594 | 0.931 | 0.721 | 0.931 | 0.790 | 554   | 6996   | 7/11/12/8                |
| motion s6 | 4x          | 0.891 | 0.611 | 0.900 | 0.747 | 0.882 | 0.792 | 586   | 16011  | 17/20/17/13              |
| motion s6 | 252 fr/tile | 0.957 | 0.550 | 0.945 | 0.714 | 0.915 | 0.789 | 563   | 2073   | 10/20/10/8               |
| static s5 | 1x          | 0.966 | 0.569 | 0.967 | 0.680 | 0.975 | 0.756 | 470   | 3550   | 4/0/6/2                  |
| static s5 | 2x          | 0.962 | 0.629 | 0.967 | 0.726 | 0.960 | 0.787 | 497   | 7690   | 6/1/9/4                  |
| static s5 | 4x          | 0.942 | 0.645 | 0.936 | 0.752 | 0.948 | 0.784 | 501   | 18824  | 11/4/9/2                 |
| static s5 | 252 fr/tile | 0.958 | 0.564 | 0.966 | 0.701 | 0.958 | 0.761 | 481   | 2214   | 10/0/8/2                 |
| static s6 | 1x          | 0.966 | 0.582 | 0.966 | 0.712 | 0.969 | 0.782 | 508   | 3446   | 6/1/7/2                  |
| static s6 | 2x          | 0.944 | 0.618 | 0.946 | 0.752 | 0.946 | 0.801 | 533   | 7411   | 15/5/9/1                 |
| static s6 | 4x          | 0.902 | 0.644 | 0.921 | 0.757 | 0.918 | 0.798 | 547   | 17652  | 18/9/12/7                |
| static s6 | 252 fr/tile | 0.960 | 0.579 | 0.959 | 0.741 | 0.939 | 0.809 | 542   | 2125   | 11/10/9/3                |

On every sim, P@8 falls as compute grows while recall rises:

- 1x → 4x: −.076 / −.065 (motion seeds 5 / 6) and −.027 / −.051 (static);
- 126 → 252 frames per tile: −.041 / −.032 (motion) and −.017 / −.030 (static).
  The recall bought by 4x is +.02–.04 R@8. Most of it arrives early (R@2 +.06–.08).

The _noise_ class grows most. It is the class to explain.

| class (motion s5, 4x, main 5871ca5) | peak SNR (QC) | QC pass | footprint radius | best trace r with any GT unit | that unit's distance | ledger transients / min | keep-test passes / fails | status               |
| ----------------------------------- | ------------- | ------- | ---------------- | ----------------------------- | -------------------- | ----------------------- | ------------------------ | -------------------- |
| tp                                  | 24.8          | 1       | 9.4 px           | .95                           | 1.6 px               | 5.0                     | 16 / 0                   | established          |
| noise                               | 4.7           | 0       | 11.1 px          | .34                           | 213 px               | 4.1                     | 5 / 0                    | 30 of 31 established |

The noise cells look like this:

- Large and diffuse, at the support cap.
- Dim: peak SNR 4.7, and they fail the QC pass rule.
- Their traces correlate only ~0.3 with any GT unit, typically one hundreds of px away. That is population-shared activity; the sim's neuropil has population coupling 0.85.
- They have real transients at a cell-like rate, and they pass their keep tests. 30 of 31 are _established_.
- They are not at vessels (23 % within 5 px of a vessel vs 26 % of random points) and not at the FOV edge.
- Motion makes 2–3x more of them than static.

So the precision lost with compute is not "early FPs that pruning will
catch". By the ledger's evidence these are cells, and they stay.

## The hypotheses (main 5871ca5, seed 5, instrumented)

**Multiple testing.**

- Measured: the false-accept rate per add test at spots with no GT unit within 7 px.
- Its nominal rate is effectively zero. The χ² margin is 5 σ of the noise-column null, _and_ there must be ≥ 2 held-out frames ≥ 4 σ (~3e-5 per frame under the null).

| run                | tests at null spots | accepted | rate per test |
| ------------------ | ------------------- | -------- | ------------- |
| motion 1x          | 2594                | 12       | 0.46 %        |
| motion 4x          | 10120               | 47       | 0.46 %        |
| motion 252 fr/tile | 1870                | 36       | **1.9 %**     |
| static 1x          | 3192                | 5        | 0.16 %        |
| static 4x          | 10112               | 10       | 0.10 %        |

- The rate per test is flat in compute. So FPs scale with the number of tests: 4x the tests gives 4x the null accepts.
- The rate does not rise with the number of earlier tests at the same spot (motion 4x): 0.5–0.75 % at k < 8, then 0.3 % at k = 8–32 and 0.1 % beyond.
- A lottery on reused frames would rise with k. Here each test is a fresh look at a persistent source.
- With twice the frames per tile, the rate per test quadruples. A noise null would not care how many frames there are. A real source with transients is easier to "confirm" the more of its transients the reservoir holds.

**Held-out reuse.**

- Tested directly: a spot tested and rejected before needed at least one held-out event from frames after that test (the rule a deleted spot already has), in the pre-test and in the add test.
- Result: no help where it matters, and a recall cost at the default budget. See "Corrections tried".

**Selection bias** (event slots are chosen by residual score, so the held-out frames are not independent of the proposal).

- It exists: held-out exceedances are about 3x higher on event slots than on random slots.
- It is not what admits the FPs. Accepted null candidates still clear the χ² null on the _random_ (unselected) held-out slots alone: median z 7.5 on motion 4x, against 10–17 for true cells.
- Excluding the selecting frames would therefore not reject them. It would cost the true cells their transients, which are exactly the frames that select them.

**Null miscalibration at larger frame counts.**

- Yes, but not as a scale error.
- At null spots, the held-out candidate coordinate exceeds 2/3/4 σ on 4.8 % / 1.8 % / 0.9 % of random slots. Gaussian values are 2.3 % / 0.13 % / 0.003 %.
- The χ² margin z0 at null spots has a median of 8–13, with 65–77 % above 5.
- The χ² test does not gate at all. The event and neighbour-trace checks do: 1 % of null-spot candidates pass them.
- The residual there is structured signal, not inflated white noise. A larger σ would not fix it.

## Corrections tried (main 5871ca5, motion seed 5; all measured, none adopted)

| correction                                                     | motion 1x P@8 / R@8 | motion 4x P@8 / R@8 | motion 252 fr/tile P@8 / R@8 |
| -------------------------------------------------------------- | ------------------- | ------------------- | ---------------------------- |
| none                                                           | .938 / .773         | .866 / .794         | .904 / .789                  |
| fresh evidence (≥ 1 held-out event after the spot's last test) | .941 / **.739**     | .878 / .797         | .905 / .771                  |
| sequential: `accept_z + 3 · ln(1 + rejections at the spot)`    | —                   | .874 / .795         | —                            |

- **Fresh evidence.** It leaves 4x and 252 fr/tile within noise (run-to-run noise ≈ .016) and costs .034 R@8 at the default budget.
- **Sequential correction** (`accept_z + c · ln(1 + tests at the spot)`).
  - Run with c = 3 at 4x: P@8 .874, within noise of .866.
  - In counterfactual replays of the logged adds, larger c blocks about one true add per false one: c = 4 blocks 34 TPs for 16 FPs.
  - The margins of the FPs (median 18–22 σ) are far above the nominal threshold. A threshold that grows only slowly with k therefore barely binds, and one that binds also stops true cells.
- **Excluding the selecting frames.** Not built. The FPs pass on unselected frames anyway (above).

## What would help (outside this PR)

The FPs are model gaps, not test gaps.

1. **A background component for population-coupled diffuse light.** Earlier measurements already showed that real data needs a global mode plus a rank-~5 low-rank background (cala-port notes). The sim's neuropil is literally 5 population-coupled components.
   - The slow loop's patch problem has only a 3 x 3 bump grid plus one free Gaussian at the candidate. A diffuse patch that is not Gaussian-shaped is cheaper as a "cell" than as background.
   - Give the add test and the keep test the same low-rank background terms the fast loop can use.
2. **Shape evidence in the keep test.** These cells pass keep tests against the free Gaussian bump, but are dim, at the support cap, and fail the QC peak-SNR rule (validated, AUC .80). A keep test against a wider nuisance family would let them fail and be pruned. That matches the "accept early, prune later" principle.
3. **Report precision vs compute as a standing check.** Any change that makes the slow loop faster turns into more tests. Until 1–2 land, precision will keep falling with speed at roughly the per-test rate in the table above.

## Real data (workshop CA1, 15 min, `discover_eval real --motion`)

Main 5871ca5 (before #309); 18 000 frames; Minian has 708 cells.

| budget | library | Minian matched r ≥ .7 | r ≥ .5 | cells without a Minian match (r < .5) | late merges (≥ frame 6000) | cohort born 2400+ removed later | late adds within 6 px of a removal in the previous 2400 frames (control) |
| ------ | ------- | --------------------- | ------ | ------------------------------------- | -------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| 1x     | 688     | 392                   | 456    | 232                                   | 175                        | 32 %                            | 4 % (2 %)                                                                |
| 4x     | 877     | 422                   | 504    | **373**                               | **411**                    | **45 %**                        | **14 %** (5 %)                                                           |

On real data the same trade appears. 4x compute buys +30 Minian matches at
r ≥ .7, but adds +141 cells Minian does not have, and more than doubles
add-then-remove churn.

## Harness additions

`qc_eval` now writes, for runs with GT:

- `gt.tsv`: GT centroids, detectable, peak SNR;
- `final.tsv`: each final cell's centroid, footprint match and slow-loop evidence (status, transients, keep-test passes / fails / redundant, peak z);
- `traces_gt.tsv`: each final cell's best trace correlation with any GT unit, and that unit's distance.
