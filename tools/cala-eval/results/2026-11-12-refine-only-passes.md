# S2.3b probe: later passes that only refine (12 Nov 2026)

Question: S2.3 (#337) found that repeating pass 1 makes footprints settle and
sharpens them (`r_fp` +.003 beyond matched budget), but false cells grow as
much as with the same extra budget. About 10–15 adds per minute remain in pass
3, mostly merges and re-adds. If passes ≥ 2 only refine, do we keep the
settling and the `r_fp` gain without the false-cell growth?

**Answer: no variant is a candidate for an app option.** Refine-only passes do
stop the false-cell growth and lift precision, but footprint supports then grow
without bound. Within one or two passes some footprints cover most of the field
of view. On sims, explained variance collapses for minutes at a time in 5 of 7
runs. On real data, textured footprints go 2–5 → 24–32. Adding merges back
keeps supports bounded, but merges with no adds or splits to balance them merge
real cells away (recall −.09 to −.16 against all edits). The structural edits
in "all" are what keep supports in check, so a refinement pass first needs the
support rule fixed.

## Setup

- **Flag.** `qc_eval --later-passes refine|refine-prune|refine-merge|all`
  (this PR; default `all`). It sets `SlowLoop::set_edit_scope` at the start of
  each pass ≥ 2.
  - `refine`: visits refine existing footprints only. There are no add
    proposals, so no adds, absorbs or re-adds. There are no splits, no merges,
    no keep tests and no deletions (probation and unsupported).
  - `refine-prune`: as `refine`, but keep tests and deletions stay on.
  - `refine-merge`: as `refine-prune`, plus merges (including the keep tests'
    forced merges).
  - A visit with nothing to do (not a refine visit, and no merges or adds
    allowed) returns before its tile solve.
  - The scope applies to in-process visits (`SlowLoop::step`); `qc_eval`
    refuses a non-`all` scope with `--via-jobs`, `--visit-workers` or
    `--offered-fps`.
- **Pass 1 is unchanged.**
  - A smoke run (motion s5, 2400 frames) gave byte-identical `global.tsv`,
    `cells.tsv`, `convergence.tsv`, `adds.tsv`, `removals.tsv` and flat-field
    log for `--passes 1` and the pass-1 slice of `--passes 2 --later-passes
refine-prune`.
  - Every pass-1 slice below (7 sims × 3 variants, 4 real runs) is
    byte-identical to the S2.3 pass-1 slice of the same arm and seed. The S2.3
    "all" runs were therefore reused as the baseline.
- **Run settings.** As S2.3: `--passes 3 --batch 8 --budget 30000000
--slow-seed 1`. Sims: `motion` and `static` arms. Real data: the workshop
  recording, `--motion --frames 18000`, slow seeds 1 and 2, `refine` and
  `refine-prune`.
- **Seeds.** Sims are on 7 seeds: motion s5, s7, s8, s9 and static s7, s8, s9.
  The macOS `/tmp` cleanup at midnight emptied the recordings of static s5, s6
  and motion s6 (and the minisim venv needed to regenerate them). Every table
  restricts all rows, including the S2.3 baselines, to these seeds, so the "1
  pass" and "all" rows differ slightly from the S2.3 note.
- **Not held out.** As in S2.3, P8 and R8 in pass k are measured 8 minutes
  into that pass. Passes ≥ 2 score frames the slow loop has already seen.

## Sims: per pass, mean over seeds

The churn columns are per minute over the pass's last 4 minutes.
`conv_big4` is the share of cells changing by more than 10 % in a minute at the
pass end.

### motion (seeds 5, 7, 8, 9)

| run              | P8    | R8    | cells | fp_noise | fp_adjacent | r_fp  | conv_big4 | adds/min | deletes/min |
| ---------------- | ----- | ----- | ----- | -------- | ----------- | ----- | --------- | -------- | ----------- |
| 1 pass, 1×       | 0.923 | 0.751 | 520.0 | 5.8      | 7.0         | 0.941 | 0.138     | 22.9     | 1.4         |
| all, pass 2      | 0.918 | 0.789 | 549.8 | 8.8      | 10.2        | 0.948 | 0.066     | 9.5      | 0.8         |
| all, pass 3      | 0.908 | 0.804 | 566.2 | 12.2     | 14.2        | 0.951 | 0.057     | 7.5      | 0.7         |
| refine, p2       | 0.952 | 0.775 | 520.0 | 6.0      | 5.5         | 0.953 | 0.076     | 0        | 0           |
| refine, p3       | 0.945 | 0.769 | 520.0 | 7.2      | 8.0         | 0.954 | 0.042     | 0        | 0           |
| refine-prune, p2 | 0.952 | 0.766 | 514.2 | 6.0      | 5.2         | 0.953 | 0.066     | 0        | 0.3         |
| refine-prune, p3 | 0.947 | 0.760 | 513.0 | 6.5      | 6.5         | 0.954 | 0.048     | 0        | 0.2         |
| refine-merge, p2 | 0.968 | 0.711 | 469.8 | 4.5      | 2.5         | 0.954 | 0.061     | 0        | 0.4         |
| refine-merge, p3 | 0.967 | 0.666 | 440.2 | 4.5      | 5.0         | 0.956 | 0.050     | 0        | 0.2         |

### static (seeds 7, 8, 9)

| run              | P8    | R8    | cells | fp_noise | fp_adjacent | r_fp  | conv_big4 | adds/min | deletes/min |
| ---------------- | ----- | ----- | ----- | -------- | ----------- | ----- | --------- | -------- | ----------- |
| 1 pass, 1×       | 0.945 | 0.786 | 505.0 | 8.3      | 5.7         | 0.973 | 0.132     | 22.2     | 1.4         |
| all, pass 2      | 0.939 | 0.822 | 531.7 | 13.3     | 6.7         | 0.979 | 0.081     | 9.2      | 0.9         |
| all, pass 3      | 0.929 | 0.836 | 547.0 | 15.7     | 10.0        | 0.981 | 0.060     | 7.2      | 0.5         |
| refine, p2       | 0.968 | 0.805 | 505.0 | 9.3      | 4.7         | 0.984 | 0.057     | 0        | 0           |
| refine, p3       | 0.964 | 0.801 | 505.0 | 9.0      | 6.7         | 0.983 | 0.059     | 0        | 0           |
| refine-prune, p2 | 0.969 | 0.798 | 500.3 | 8.3      | 4.7         | 0.984 | 0.049     | 0        | 0.3         |
| refine-prune, p3 | 0.963 | 0.792 | 499.7 | 9.7      | 5.7         | 0.984 | 0.099     | 0        | 0           |
| refine-merge, p2 | 0.967 | 0.715 | 448.7 | 9.0      | 3.0         | 0.984 | 0.071     | 0        | 0           |
| refine-merge, p3 | 0.972 | 0.673 | 421.0 | 8.0      | 2.7         | 0.986 | 0.049     | 0        | 0.1         |

### Paired differences

Mean ± 95 % t-CI, with sign counts (+/−). n = 4 for motion and 3 for static.

| comparison               | arm    | P8                 | R8                 | cells      | fp_noise   | r_fp               | conv_big4          |
| ------------------------ | ------ | ------------------ | ------------------ | ---------- | ---------- | ------------------ | ------------------ |
| refine p2 − 1 pass       | motion | +.029 ± .012 (4/0) | +.023 ± .009 (4/0) | 0.0        | +0.2 ± 0.8 | +.012 ± .003 (4/0) | −.062 ± .058 (0/4) |
| refine p2 − 1 pass       | static | +.023 ± .011 (3/0) | +.019 ± .010 (3/0) | 0.0        | +1.0 ± 5.0 | +.010 ± .006 (3/0) | −.076 ± .018 (0/3) |
| refine p3 − all p3       | motion | +.037 ± .034 (4/0) | −.036 ± .018 (0/4) | −46 ± 14   | −5.0 ± 3.9 | +.003 ± .003 (3/1) | −.015 ± .034       |
| refine p3 − all p3       | static | +.035 ± .043 (3/0) | −.035 ± .022 (0/3) | −42 ± 9    | −6.7 ± 19  | +.002 ± .003 (3/0) | −.001 ± .080       |
| refine-prune p2 − 1 pass | motion | +.028 ± .012 (4/0) | +.014 ± .007 (4/0) | −5.8 ± 2.0 | +0.2 ± 0.8 | +.013 ± .004 (4/0) | −.072 ± .064 (0/4) |
| refine-prune p2 − 1 pass | static | +.024 ± .009 (3/0) | +.012 ± .002 (3/0) | −4.7 ± 3.8 | 0.0 ± 2.5  | +.011 ± .006 (3/0) | −.083 ± .037 (0/3) |
| refine-prune p3 − all p3 | motion | +.039 ± .034 (4/0) | −.045 ± .017 (0/4) | −53 ± 15   | −5.8 ± 2.0 | +.002 ± .004 (3/0) | −.009 ± .048       |
| refine-prune p3 − all p3 | static | +.034 ± .031 (3/0) | −.044 ± .014 (0/3) | −47 ± 8    | −6.0 ± 15  | +.003 ± .003 (3/0) | +.039 ± .145       |
| refine-merge p3 − 1 pass | motion | +.043 ± .017 (4/0) | −.086 ± .015 (0/4) | −80 ± 13   | −1.2 ± 2.4 | +.015 ± .001 (4/0) | −.088 ± .021 (0/4) |
| refine-merge p3 − 1 pass | static | +.026 ± .012 (3/0) | −.113 ± .025 (0/3) | −84 ± 10   | −0.3 ± 10  | +.013 ± .005 (3/0) | −.083 ± .033 (0/3) |

Full `summarize.py` reports are in the session scratchpad (`s23b/reports/`).

### Taken at face value, refine-only looks like a win

- **No false-cell growth.** `fp_noise` stays at its pass-1 level (+0.2 to
  +1.5, CIs cover 0), against +3 to +7 for "all".
- **Higher P8.** P8 rises +.02 to +.03 over one pass, with every seed positive,
  because the fixed cell set's footprints match ground truth better.
- **Better `r_fp`.** `r_fp` gains +.010 to +.013 over pass 1, and +.002 to +.005
  over "all" at the same pass.
- **Settling.** The end-of-pass `conv_big4` falls about as it does with "all"
  (.14 → .04–.10). This end-of-pass share is noisy per seed (refine-prune
  static p3: .041 / .122 / .135), so the variants cannot be ranked on it.

### Supports grow without bound

Footprint support sizes at each pass end, over the 7 sims runs:

| variant      | pass | median support (px) | p99 support (px) | largest footprint (px, median over runs) | runs with a footprint > 50k px |
| ------------ | ---- | ------------------- | ---------------- | ---------------------------------------- | ------------------------------ |
| all          | 1    | 1135                | 3344             | 7543                                     | 0/7                            |
| all          | 2    | 1254                | 4755             | 9504                                     | 1/7                            |
| all          | 3    | 1258                | 5459             | 11680                                    | 0/7                            |
| refine       | 2    | 1515                | 13748            | 239996                                   | 6/7                            |
| refine       | 3    | 1684                | 28493            | 348909                                   | 7/7                            |
| refine-prune | 2    | 1520                | 11616            | 80424                                    | 5/7                            |
| refine-prune | 3    | 1682                | 22772            | 347049                                   | 6/7                            |
| refine-merge | 2    | 1407                | 7163             | 14532                                    | 0/7                            |
| refine-merge | 3    | 1521                | 10544            | 30795                                    | 1/7                            |

The field of view is 360 000 px, so the largest refine-only footprints cover
almost all of it.

**Fit breakdowns.** These runaway footprints break the fit:

- In 5 of 7 `refine` runs and 4 of 7 `refine-prune` runs, the fast loop's
  explained variance falls below .85 at some checkpoint in pass 2 or 3. It
  bottoms at .32–.57, and at .07 for `refine-prune` motion s7, where it is
  negative for about 2000 frames and about half the cells sit in correlated
  pairs.
- Recovery takes about 1000–3000 frames.
- "all" and `refine-merge` never fall below .86 after pass 1.
- The 8-minute metrics above often miss these episodes because they sample
  after the recovery.

### Merges without adds or splits

`refine-merge` keeps supports bounded, but merges then remove real cells with
nothing to balance them. Cells fall by 80–84 against one pass, and R8 by .09 to
.11. In "all", re-adds and splits put such cells back.

## Real data: workshop recording, 18000 frames per pass

The "all" rows are the S2.3 runs (#337). Pass 1 is byte-identical in every run.

| seed | variant      | pass | cells | share >10 %/min | texture | Minian r ≥ .5 | Minian r ≥ .7 | median support | p99 support | largest footprint |
| ---- | ------------ | ---- | ----- | --------------- | ------- | ------------- | ------------- | -------------- | ----------- | ----------------- |
| 1    | (pass 1)     | 1    | 663   | 0.136           | 2       | 503           | 410           | 619            | 3584        | 8495              |
| 1    | all          | 2    | 699   | 0.068           | 2       | 527           | 429           | 775            | 4774        | 9852              |
| 1    | all          | 3    | 768   | 0.030           | 7       | 569           | 441           | 799            | 6176        | 14106             |
| 1    | refine       | 2    | 664   | 0.108           | 11      | 529           | 436           | 1388           | 17674       | 181236            |
| 1    | refine       | 3    | 664   | 0.053           | 32      | 527           | 425           | 1813           | 31890       | 215140            |
| 1    | refine-prune | 2    | 662   | 0.124           | 6       | 524           | 431           | 1387           | 16014       | 202102            |
| 1    | refine-prune | 3    | 662   | 0.039           | 24      | 529           | 420           | 1812           | 23239       | 235689            |
| 2    | (pass 1)     | 1    | 696   | 0.107           | 5       | 525           | 411           | 617            | 4577        | 6654              |
| 2    | all          | 2    | 754   | 0.071           | 9       | 535           | 410           | 708            | 5938        | 11308             |
| 2    | all          | 3    | 765   | 0.034           | 9       | 550           | 423           | 807            | 7388        | 24887             |
| 2    | refine       | 2    | 696   | 0.106           | 14      | 560           | 442           | 1517           | 24344       | 143872            |
| 2    | refine       | 3    | 696   | 0.049           | 27      | 558           | 437           | 2115           | 71048       | 277600            |
| 2    | refine-prune | 2    | 695   | 0.091           | 11      | 555           | 437           | 1384           | 16801       | 80821             |
| 2    | refine-prune | 3    | 695   | 0.084           | 30      | 555           | 424           | 1961           | 39970       | 295767            |

- **Seed-to-seed Jaccard** (cos ≥ .5) by pass:

  | variant      | pass 1 | pass 2 | pass 3 |
  | ------------ | ------ | ------ | ------ |
  | all (S2.3)   | .678   | .672   | .675   |
  | refine       | .678   | .711   | .698   |
  | refine-prune | .678   | .709   | .711   |

- **Settling.** The late share of cells changing by more than 10 % in a minute
  falls more slowly than with "all": .09–.12 in pass 2 against .07, and .04 to
  .08 in pass 3 against .03. With the cell set frozen, every late change is a
  refine, and the refines keep enlarging supports.
- **Texture.** Textured footprints rise from 2 / 5 to 24–32 by pass 3, against
  7 / 9 for "all".
- **Minian.** Minian agreement at r ≥ .5 rises in pass 2 (+21 to +35) and then
  stays flat. Minian is a reference with missing and wrong cells; these rows
  are agreement, not recall.
- **Fit.** Real data shows no fit breakdown (minimum explained variance .80 to
  .82 per pass, as with "all").
- **Wall time.** Passes 2 and 3 are slower than pass 1: 890–1040 s and
  1670–2150 s, against 590–620 s. Three runs shared the machine, so the
  comparison is rough. The likely cause is that the larger supports make every
  refine and every library build cost more.

## What this means

1. **The structural edits are what keep supports bounded.**
   - Supports grow under "all" too, just slowly: the real p99 goes 3.6k → 4.8k
     → 6.2k px over three passes.
   - The support rule extends a footprint while its ring's light is
     significant. Its standard error shrinks as the running statistics
     accumulate frames, so a later pass has more power to call faint
     background light "significant".
   - In "all", merges, splits and absorbs reset a cell's statistics, and
     adds put competing columns next to it. Both stop the growth from running
     away.
   - This mechanism is inferred from the support sizes and the timing. It was
     not tested directly.
2. **Pruning alone does not help.** The keep tests delete only 1–7 cells per
   run and never the runaway ones. Those footprints explain light, so they pass
   their keep tests.
3. **Recommendation.** No variant keeps the settling and the accuracy without
   a loss. The candidates, and why each fails:
   - **`refine` and `refine-prune`:** precision holds, but supports run away,
     texture rises 5–6× on real data, and the fit breaks down on sims.
   - **`refine-merge`:** supports stay bounded, but recall collapses.
   - **Next step:** make the support rule stable under accumulating statistics
     before a refinement pass becomes an app option. A test could hold support
     growth to the noise level of the pass-1 estimate, or require new rings to
     carry the cell's _transient_ light rather than just significant light.
     Neither would be a size cap. Then rerun this probe with the same flag.
   - **Default stays `all`.** The flag stays in `qc_eval` for that rerun.

**Limits:**

- The sims use 7 seeds, not 10.
- Real data has 2 slow seeds and only the two refine variants.
- Support sizes are measured at pass ends only.
- The fit breakdowns were read from the 100-frame `global.tsv` checkpoints.
- Wall times are from a shared machine.
