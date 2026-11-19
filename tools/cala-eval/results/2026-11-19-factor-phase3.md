# Factor pipeline, phase 3a: Refine on factors against a raw Refine

Spec: `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md` (section 5 "Refine on factors"; phases table row 3; Amendment 1, A1; Amendment 2, A8 and A11).
Plan: `docs/superpowers/plans/2026-11-19-cala-factor-phase3.md` (phase 3a).
Commits: `qc_eval` built at bfc820a9 on `feat/cala-factor-extract` (the commit named in the run folder's `BUILT_FROM`); the commits after it changed doc comments, one refusal of an unused input and one removed duplicate check in the crate, and the report tools. The report tables were rebuilt with the tools at HEAD of the same branch (tools last changed at 68c29d60). Machine: Apple M1 Max, 10 cores, 32 GB. Runs of 19 Nov 2026, 01:40 to 02:40. Data: the run folder `factor_phase3_20261119`.

Phase 3a built a Refine that runs on the compressed windows ("factors": 600 preprocessed frames per window, stored low-rank per tile) and never rebuilds a whole frame. The cell set is frozen. One iteration reads the factors to get the traces with the current library, fills each cell's footprint statistics from the factors, rebuilds a few held-out frame patches per tile from the factors, runs the existing proposal and gate code, and publishes the accepted refinements as the next library. Iterations repeat until the footprints settle: fewer than 2 percent of the cells have a footprint that correlates below 0.99 with its footprint of the previous iteration (the "changed share"), with a cap of 20 iterations. Phase 3b (carrying main's cluster history replay on the factors, the joint flags) is planned and not built: the iteration refuses the joint update.

Gate A1 compares an arm with the raw pipeline over the QC-pass cells (cells of the reference run that pass the quality check). Its rules: 1 truth correlation change (median at least -0.01, 5th percentile at least -0.05, where the truth is usable); 2 footprint loss at most 0.02; 3 trace loss at most 0.08 (where the truth is not usable); 4 footprint jump at tile lines at most the reference's plus 0.10. A loss is 1 minus the median of a measure over the QC-pass cells (footprint cosine; lag-1 trace correlation). A QC-pass cell that the arm loses counts as the worst case.

Arms per recording: `raw` (the file pipeline with Refine replays on the raw frames: 5 at 200 px, 2 at 600 px; the reference), `null_lo` and `null_hi` (`raw` with half and twice the slow-loop budget in the replays; `null_hi` at 200 px only), `f_chosen` (Refine on factors), and on `plain` also `f_null` (a repeat of `f_chosen` with another later budget; a factor Refine reads no budget, so this is a repeat run: it shows reproducibility, nothing about machine speed).

## Summary

| recording | gate A1 | failing rule                      | QC-pass cells (lost) | iterations, stop | footprint loss against raw | largest null footprint loss |
| --------- | ------- | --------------------------------- | -------------------- | ---------------- | -------------------------- | --------------------------- |
| wl200     | pass    | -                                 | 63 (0)               | 6, settled       | 0.0113                     | 0.00025                     |
| wl24_01   | fail    | 2 footprints: 0.0345 against 0.02 | 58 (0)               | 20, cap          | 0.0345                     | 0.00167                     |
| wl24_04   | fail    | 2 footprints: 0.0389 against 0.02 | 40 (0)               | 19, settled      | 0.0389                     | 0.00159                     |
| plain     | pass    | -                                 | 142 (0)              | 4, settled       | 0.0009                     | 0.00022                     |
| v4        | pass    | -                                 | 202 (0)              | 5, settled       | 0.0189                     | 0.00549                     |
| motion    | pass    | -                                 | 178 (0)              | 20, cap          | 0.0177                     | 0.00632                     |

"Footprint loss against raw" is 1 minus the median footprint cosine between the arm's library and the final `raw` library, over the QC-pass cells; the limit of rule 2 is 0.02. The null column is the largest such loss of a null run (`raw` at another budget): a same-algorithm baseline that gives the scale of the raw pipeline's own run-to-run variation, not a significance test.

**Where it passes and fails.** `f_chosen` passes gate A1 on `wl200`, `plain`, `v4` and `motion`. It fails rule 2 on `wl24_01` (0.0345) and `wl24_04` (0.0389), with no QC-pass cell lost and with trace loss and tile lines passing there.

**`wl200` passes on the truth rule only.** Its trace loss is 0.1082, which would fail rule 3 (0.08). Rule 3 does not apply because the truth is usable: 22 QC-pass cells match a truth unit (20 needed) and the reference's median truth correlation is 0.813 (0.8 needed).

**The WL24 failures are not the reference's own movement.** The raw reference's last step (the loss between its last two passes) is 0.0022 and 0.0030, under a tenth of 0.0345 and 0.0389. On the WL24 pair the loss against `raw` falls in the first iterations (`wl24_01`: 0.0698 for Discover's library, 0.0419 after iteration 1) and then plateaus above 0.02: 0.0334 to 0.0362 from iteration 3 on `wl24_01`, 0.0388 to 0.0441 from iteration 5 on `wl24_04`. More iterations did not bring it to the limit.

**The passes on `v4` and `motion` are not robust.** `v4` passes with 0.0189: its margin (0.0011) is smaller than its null spread (0.0055). `motion` passes with 0.0177: its margin (0.0023) is smaller than the reference's own last step (0.0059).

**Against the truth, where one exists** (`wl200`, `plain`, `motion`; none exists for the WL24 recordings). The library median of the truth footprint correlation at the stop is at or above the last raw pass (+0.0072, +0.0003, +0.0020). The paired per-cell measure (factor arm minus `raw`, same cell) has a median of 0.0000 on `wl200` and `plain` and -0.0009 on `motion`, and a worse 5th percentile on `wl200` (-0.0549) and `motion` (-0.0885) than on `plain` (-0.0118).

**The reference is not a settled raw Refine** (5 replays at 200 px, 2 at 600 px; on its last pass 4 to 41 percent of its cells still changed), so the spec's gate is met only approximately. The footprints settled on four recordings (4 to 19 iterations; `wl24_04` by one step, after shares of 0.03 to 0.09 over iterations 10 to 18); two stopped at the cap of 20, each with one cell more changed than the rule allows (3 against 2; 6 against 5). Phase 3b is not built, and the gate with the joint flags on was not run.

Decision: open, for the owner. The owner must decide:

- **Whether Refine on factors is good enough to go on to 3b and the app,** given that it fails rule 2 on both WL24 recordings by a plateau that more iterations did not move, and that its passes on `v4` and `motion` are not robust. The data: the table above, "Where the footprint loss sits" and "Settling".
- **Which difference between the factor Refine's algorithm and the raw Refine's to isolate first.** The gate cannot be met on the WL24 recordings by iterating longer. The candidates are listed under "What the baselines are" (no forgetting, fixed noise map and library per iteration, every cell on the statistics path, held-out patches chosen and stored differently); an arm that applies the raw Refine's forgetting to the factor statistics, or a raw Refine without forgetting, would test the first. No arm isolates any of them.
- **Whether the gate is to be run again against a raw Refine that has settled** (more raw passes; one raw Refine replay took 43 to 119 s of wall under this run's load, see "Cost"). It would firm up the two marginal passes (`v4`, `motion`); it would not change the WL24 failures, since the reference's last step there is under a tenth of the loss.
- **The settle thresholds or the cap,** with the per-iteration evidence of "Settling": the share and loss by iteration, and what a share limit of 0.03 or 0.05 would have stopped at. The tool does not run non-default thresholds (it refuses those flags in `--extra`).
- **The rotating held-out split** (below): keep parity with the raw route, or fix the split on both routes.
- **The departures from the spec** (section "What differs from the spec", now including "no forgetting"), each marked "for the owner".

## Gate (3a, joint flags off)

### (a) Unit tests

The two tests of the gate in the plan are `statistics_from_the_factors_equal_the_frame_route_on_rebuilt_frames` and `one_iteration_accepts_what_the_frame_route_accepts` (both in `crates/cala/src/discover/factor_refine.rs`). They passed when the commits that added and fixed them were reviewed (e236d40a and 1cd7fe6c for the first; fade1bde and 13af2b5c for the second), in the whole-phase review at bfc820a9 (all 13 tests of the module) and in the fix wave ending at a94bb25e (311 library tests). They were not run again for this report: another run was using the machine.

What they show:

- **Statistics.** On a three-cell fixture and three background models, the statistics filled from the factors equal the frame code's, on frames rebuilt from the same factors, to `1e-5 · S + 1e-4` per sum (S the size of the sum). The largest gap seen was 9 percent of that tolerance. Mutations of the formula that the reviewers ran (the exclusion correction, the ring and basis terms, the neighbours reached only through the moat) fail the test.
- **One iteration.** With two background models and the same three-cell fixture, one factor iteration accepts and refuses the same refinements as the frame route on rebuilt frames. A rejection is pinned in both arms (a `refine_z` between the two values), as are the published library's version and the reset of the statistics weight.

What they do not show:

- The existing refine visit's own load of held-out frames from the reservoir slots is not compared with the new gate on the same patches. The raw route and the factor route are compared on data only, by the gate below.
- Three cells and Offset tiling only for the statistics test; no test has several slow-loop tiles with cells.
- A short last window was run in a scratch copy of the tests during review (a recording of 1450 frames, last window 250; both tilings) and passed; no committed test and no gate run covers it (12000 / 600 and 6000 / 600 divide exactly).

### (b) Gate A1 per recording, `f_chosen` against `raw`

| recording | QC-pass cells | lost | 1 truth: median, 5th pct                                          | 2 footprint loss (limit 0.02) | 3 trace loss (limit 0.08) | 4 jump, arm / raw (limit +0.10) | gate |
| --------- | ------------- | ---- | ----------------------------------------------------------------- | ----------------------------- | ------------------------- | ------------------------------- | ---- |
| wl200     | 63            | 0    | median +0.0084, 5th pct -0.0193, 22 cells: pass                   | 0.0113: pass                  | 0.1082: does not apply    | 0.940 / 0.976 (-0.036): pass    | pass |
| wl24_01   | 58            | 0    | no truth: does not apply                                          | 0.0345: fail                  | 0.0611: pass              | 1.054 / 0.995 (+0.059): pass    | fail |
| wl24_04   | 40            | 0    | no truth: does not apply                                          | 0.0389: fail                  | 0.0570: pass              | 1.068 / 1.049 (+0.019): pass    | fail |
| plain     | 142           | 0    | median +0.0015, 5th pct -0.0140, 135 cells: pass                  | 0.0009: pass                  | 0.0017: does not apply    | 0.997 / 0.962 (+0.035): pass    | pass |
| v4        | 202           | 0    | no truth: does not apply                                          | 0.0189: pass                  | 0.0038: pass              | 0.928 / 0.929 (-0.001): pass    | pass |
| motion    | 178           | 0    | not usable (92 cells, median 0.403 of 0.8 needed): does not apply | 0.0177: pass                  | 0.0048: pass              | 0.891 / 0.897 (-0.006): pass    | pass |

Every row: no QC-pass cell lost. The truth rule applies on `wl200` and `plain` only: `motion` has truth, but its match is not usable (92 cells, median 0.403, 0.8 needed), so rule 3 applies there; `wl24_01`, `wl24_04` and `v4` have no truth. On `wl200` the trace loss (0.1082) is above 0.08; rule 3 does not apply there because the truth is usable (phase 1's `chosen`: 0.1039). The footprint loss recomputed from `footprints.bin` equals the tool's value on all six.

The footprint and trace losses beside two baselines. Both run the same raw Refine algorithm as `raw`: the null runs (`raw` at half and twice the slow-loop budget; "null spread" is the largest loss of a null run against `raw`) and phase 1's `chosen` (the raw Refine code on frames rebuilt from the factors). They sit near `raw` by construction, so the ratios below give scale, not significance. The `raw` and `null_lo` footprint files of this run are the same bytes as phase 1's on all six recordings (checked), so the numbers share one reference:

| recording | `f_chosen` footprint loss | largest null footprint loss | phase 1 `chosen` footprint loss | `f_chosen` / null | `f_chosen` trace loss (lag 1) | largest null trace loss | phase 1 `chosen` trace loss | footprint loss, percent of the 0.02 limit |
| --------- | ------------------------- | --------------------------- | ------------------------------- | ----------------- | ----------------------------- | ----------------------- | --------------------------- | ----------------------------------------- |
| wl200     | 0.01134                   | 0.00025                     | 0.00519                         | 45.4              | 0.10823                       | 0.00002                 | 0.10390                     | 57                                        |
| wl24_01   | 0.03450                   | 0.00167                     | 0.00857                         | 20.7              | 0.06109                       | 0.00090                 | 0.04411                     | 172                                       |
| wl24_04   | 0.03890                   | 0.00159                     | 0.00722                         | 24.5              | 0.05700                       | 0.00059                 | 0.04866                     | 194                                       |
| plain     | 0.00086                   | 0.00022                     | 0.00003                         | 3.9               | 0.00169                       | 0.00001                 | 0.00147                     | 4                                         |
| v4        | 0.01895                   | 0.00549                     | 0.00000                         | 3.5               | 0.00379                       | 0.00043                 | 0.00101                     | 95                                        |
| motion    | 0.01768                   | 0.00632                     | 0.00063                         | 2.8               | 0.00479                       | 0.00095                 | 0.00091                     | 88                                        |

What the table shows:

- **WL24, scale:** the factor Refine's footprint loss is 0.0345 and 0.0389, against null spreads of 0.0017 and 0.0016 and phase 1 `chosen` losses of 0.0086 and 0.0072 (about 21 and 24 times the null spread, 4 and 5 times `chosen`). The trace losses are also above `chosen`'s (0.0611 against 0.0441; 0.0570 against 0.0487) and pass rule 3.
- **`wl200`:** 0.0113 against 0.0052 for `chosen`; it passes with 57 percent of the limit.
- **`v4` and `motion` pass close to the limit:** 0.0189 is 95 percent of 0.02 and 0.0177 is 88 percent. The margin (0.0011 and 0.0023) is less than the null spread (0.0055 and 0.0063) and, on `motion`, less than the reference's own last step (0.0059). On `motion` the stop rule could not have ended the run at iterations 12 or 13 (5 cells are allowed to change; 10 and 13 changed), but a manual stop there would have passed with losses of 0.0198 and 0.0197.
- **`plain`:** 0.0009, 4 times the null spread, far below the limit.

### What the baselines are not

The factor Refine differs from the raw Refine in its algorithm, not only in its route. Each difference below is an untested candidate cause of the WL24 plateau; no arm isolates any of them.

- **No forgetting.** Every fitting frame has weight 1 in the footprint statistics; the raw Refine forgets with a half-life (an infinite half-life is what the frame route's equality test uses).
- **A fixed noise map and a fixed library per iteration.** The noise map is set once after the compression replay (a raw pass refreshes it every 200 frames); the library does not change inside an iteration.
- **Every cell on the statistics path.** The reservoir path for young cells is not used.
- **Held-out patches chosen and stored differently:** by trace activity plus a hash, rebuilt from the factors, stored quantised (see "What differs from the spec").
- Also the route (factors), the number of passes (19 or 20 iterations against 4 or 5 replays) and the library each starts from.

### Where the footprint loss sits

| recording | loss recomputed from `footprints.bin` | loss in the report | null runs, recomputed            | share of QC-pass cells with cosine below 0.9 | loss near / far from a tile line (8 px) |
| --------- | ------------------------------------- | ------------------ | -------------------------------- | -------------------------------------------- | --------------------------------------- |
| wl200     | 0.01134                               | 0.01134            | null_lo 0.00025, null_hi 0.00012 | 0.016                                        | 0.0144 (45 cells) / 0.0097 (18 cells)   |
| wl24_01   | 0.03450                               | 0.03450            | null_lo 0.00167, null_hi 0.00149 | 0.276                                        | 0.0356 (47 cells) / 0.0334 (11 cells)   |
| wl24_04   | 0.03890                               | 0.03890            | null_lo 0.00159, null_hi 0.00090 | 0.175                                        | 0.0483 (30 cells) / 0.0175 (10 cells)   |
| plain     | 0.00086                               | 0.00086            | null_lo 0.00022                  | 0.014                                        | 0.0009 (108 cells) / 0.0006 (34 cells)  |
| v4        | 0.01895                               | 0.01895            | null_lo 0.00549                  | 0.129                                        | 0.0195 (148 cells) / 0.0158 (54 cells)  |
| motion    | 0.01768                               | 0.01768            | null_lo 0.00632                  | 0.112                                        | 0.0176 (143 cells) / 0.0205 (35 cells)  |

- On `wl24_01` 28 percent of the QC-pass cells (16 of 58) and on `wl24_04` 18 percent (7 of 40) have a footprint cosine to `raw` below 0.9, against 1 to 2 percent on `wl200` and `plain`. The loss is a tail of cells, not a shift of all.
- Near or far from a tile line (8 px): no difference on `wl24_01` (0.0356 against 0.0334); on `wl24_04` the loss is larger near lines (0.0483 against 0.0175), but the group away from lines is 10 cells, so this is thin.
- `low_valid` (below) counts 3 cells on each WL24 recording: too few to move a median over 58 and 40 cells (inferred).

### (c) The reference is not a settled raw Refine

The raw arm has 5 Refine replays at 200 px and 2 at 600 px. The settle table measures it with the same definition as the factor iterations (changed share between one pass and the next). Its last two passes:

| recording | `raw` Refine replays | changed share, replay before the last | changed share, last replay | median 1 - r of changed cells, last replay | wall s of one Refine replay (shortest to longest) |
| --------- | -------------------- | ------------------------------------- | -------------------------- | ------------------------------------------ | ------------------------------------------------- |
| wl200     | 5                    | 0.028                                 | 0.0417                     | 0.0264                                     | 43 to 46                                          |
| wl24_01   | 5                    | 0.343                                 | 0.3039                     | 0.0359                                     | 57 to 63                                          |
| wl24_04   | 5                    | 0.344                                 | 0.3750                     | 0.0212                                     | 50 to 53                                          |
| plain     | 2                    | 0.534                                 | 0.1489                     | 0.0356                                     | 92 to 93                                          |
| v4        | 2                    | 0.849                                 | 0.3744                     | 0.0480                                     | 101 to 119                                        |
| motion    | 2                    | 0.912                                 | 0.4122                     | 0.0258                                     | 97 to 100                                         |

Only `wl200` comes near the rule on its last two passes (0.028 and 0.042, against under 0.02). On the other five recordings between 15 and 41 percent of the cells still changed on the last pass. By the rule's own measure the reference is not settled, and at 600 px it had 2 replays. The spec's gate ("against a settled raw Refine") is therefore met only approximately.

On the gate's own measure the reference moves little in its last step (median footprint loss of the second-to-last pass against the final one, last column of the table "Loss against `raw` by iteration" below): 0.0002, 0.0022 and 0.0030 on `wl200`, `wl24_01` and `wl24_04`; 0.0000, 0.0005 and 0.0059 on `plain`, `v4` and `motion`. For the two WL24 recordings that is under a tenth of `f_chosen`'s loss (0.0022 against 0.0345; 0.0030 against 0.0389). For `motion` it is a third of `f_chosen`'s loss (0.0059 against 0.0177). How a settled raw run would differ was not measured.

## Settling

The settle table of each recording's `report.md` gives, per library, the changed share and the median of 1 - r over the cells that changed. This report adds the footprint loss of each library against the final `raw` library, over the QC-pass cells (the gate's measure; for `f_chosen` the last row equals the gate's loss), and the truth footprint r where a truth exists.

| recording | iterations | stop    | changed share, first four and last four iterations  | `raw` changed share, last two passes | cells |
| --------- | ---------- | ------- | --------------------------------------------------- | ------------------------------------ | ----- |
| wl200     | 6          | settled | 0.222 0.028 0.042 0.028 ... 0.042 0.028 0.069 0.014 | 0.028 then 0.042 (pass 5 then 6)     | 72    |
| wl24_01   | 20         | cap     | 0.510 0.265 0.284 0.137 ... 0.039 0.039 0.039 0.029 | 0.343 then 0.304 (pass 5 then 6)     | 102   |
| wl24_04   | 19         | settled | 0.406 0.188 0.234 0.141 ... 0.047 0.031 0.031 0.000 | 0.344 then 0.375 (pass 5 then 6)     | 64    |
| plain     | 4          | settled | 0.484 0.106 0.048 0.016                             | 0.534 then 0.149 (pass 2 then 3)     | 188   |
| v4        | 5          | settled | 0.612 0.178 0.110 0.068 ... 0.178 0.110 0.068 0.014 | 0.849 then 0.374 (pass 2 then 3)     | 219   |
| motion    | 20         | cap     | 0.695 0.344 0.244 0.160 ... 0.031 0.034 0.038 0.023 | 0.912 then 0.412 (pass 2 then 3)     | 262   |

At these cell counts the rule lets 1 cell change on `wl200` (72 cells) and `wl24_04` (64), 2 on `wl24_01` (102), 3 on `plain` (188), 4 on `v4` (219) and 5 on `motion` (262). The capped runs stopped just above that: `wl24_01` had 3 cells changed at iteration 20, `motion` 6; `wl24_04` had 2 at iterations 17 and 18 and settled with 0 at iteration 19.

What the changed share did at the end of the runs that hit the cap:

- **`wl24_04` (settled, for comparison):** shares of 0.03 to 0.09 over iterations 10 to 18, then 0.031, 0.031 and 0.000 at iteration 19: it settled by one step and is close to the capped runs.
- **`wl24_01`:** a slow fall with plateaus, not an oscillation. The last five shares are 0.049, 0.039, 0.039, 0.039, 0.029. Over iterations 12 to 20, 23 distinct cells changed (52 changes, 12 cells in two or more iterations), and 5 of the 52 changes put the cell back within 0.99 of its state two iterations before. The cells that change are not the same each iteration: only cell 81 changed in all of the last three iterations.
- **`motion`:** a plateau at 0.02 to 0.05 from iteration 10 on, with ups and downs (0.046, 0.046, 0.038, 0.050, 0.046, 0.046, 0.042, 0.031, 0.034, 0.038, 0.023 for iterations 10 to 20). Over iterations 12 to 20, 41 distinct cells changed (91 changes, 16 cells in two or more), and 9 of the 91 changes returned to within 0.99 of the state two before. Four cells (21, 75, 84, 176) changed in all of the last three iterations.

| recording | iterations | cell changes (r below 0.99 to the iteration before) | distinct cells that changed | cells that changed in two or more of them | changes that are back within 0.99 of the iteration two before |
| --------- | ---------- | --------------------------------------------------- | --------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| wl200     | 2 to 6     | 13                                                  | 12                          | 1                                         | 0 of 11                                                       |
| wl24_01   | 12 to 20   | 52                                                  | 23                          | 12                                        | 5 of 52                                                       |
| wl24_04   | 11 to 19   | 28                                                  | 17                          | 5                                         | 1 of 28                                                       |
| plain     | 2 to 4     | 32                                                  | 29                          | 3                                         | 0 of 12                                                       |
| v4        | 2 to 5     | 81                                                  | 68                          | 11                                        | 1 of 42                                                       |
| motion    | 12 to 20   | 91                                                  | 41                          | 16                                        | 9 of 91                                                       |

(For runs of 10 iterations or fewer the first iteration has no iteration two before, so its changes are in the third column but not in the last column's denominator.) A small set of cells keeps moving; only a minority of its moves are a swing back and forth (inferred: slow drift of those cells rather than a two-state oscillation).

### Loss against `raw` by iteration: does more settling help?

| recording | loss after iteration 1 | lowest loss           | loss at the stop | first iteration with loss at most 0.02 | iterations that lowered the loss | loss of `raw`'s second-to-last pass to its final |
| --------- | ---------------------- | --------------------- | ---------------- | -------------------------------------- | -------------------------------- | ------------------------------------------------ |
| wl200     | 0.0170                 | 0.0113 (iteration 5)  | 0.0113           | 1                                      | 4 of 5                           | 0.0002                                           |
| wl24_01   | 0.0419                 | 0.0334 (iteration 11) | 0.0345           | never                                  | 6 of 19                          | 0.0022                                           |
| wl24_04   | 0.0601                 | 0.0388 (iteration 14) | 0.0389           | never                                  | 6 of 18                          | 0.0030                                           |
| plain     | 0.0012                 | 0.0009 (iteration 3)  | 0.0009           | 1                                      | 2 of 3                           | 0.0000                                           |
| v4        | 0.0227                 | 0.0189 (iteration 4)  | 0.0189           | 3                                      | 3 of 4                           | 0.0005                                           |
| motion    | 0.0293                 | 0.0161 (iteration 4)  | 0.0177           | 2                                      | 9 of 19                          | 0.0059                                           |

- `wl200`, `plain`, `v4`: the loss falls to its lowest value at or just before the stop (the stop is where the footprints stop changing).
- `wl24_01`: 0.0698 for Discover's library, 0.0419 after one iteration, then between 0.0334 and 0.0362 from iteration 3 to the cap. Only 6 of 19 iterations lowered it. More iterations do not bring it to 0.02, and an earlier stop would not pass: the loss at iteration 1 is 0.0419.
- `wl24_04`: 0.0693, 0.0601 after one iteration, between 0.0388 and 0.0441 from iteration 5 on.
- `motion`: 0.0161 at iteration 4, then up to 0.0198, down to 0.0176 and 0.0177 at the cap; it was at most 0.0198 at every iteration from 2 to 20. `v4` first passed at iteration 3.

Footprints keep moving after the loss has stopped falling (from iteration 8 the changed share on `wl24_01` is 0.03 to 0.11 while its loss stays at 0.0334 to 0.0362), so the later changes neither move toward nor away from the reference on the median (inferred; the per-cell direction was not measured).

What other stop limits would have done, from the same runs (no run was made with other thresholds; the first iteration whose changed share is below the limit, and the loss at that iteration):

| recording | first iteration with share below 0.02 (the rule) | below 0.03       | below 0.05       |
| --------- | ------------------------------------------------ | ---------------- | ---------------- |
| wl200     | 6 (loss 0.0113)                                  | 2 (loss 0.0161)  | 2 (loss 0.0161)  |
| wl24_01   | never in the run                                 | 20 (loss 0.0345) | 15 (loss 0.0345) |
| wl24_04   | 19 (loss 0.0389)                                 | 19 (loss 0.0389) | 10 (loss 0.0426) |
| plain     | 4 (loss 0.0009)                                  | 4 (loss 0.0009)  | 3 (loss 0.0009)  |
| v4        | 5 (loss 0.0189)                                  | 5 (loss 0.0189)  | 5 (loss 0.0189)  |
| motion    | never in the run                                 | 20 (loss 0.0177) | 10 (loss 0.0190) |

A limit of 0.05 would stop `wl24_01` at iteration 15, `wl24_04` at 10 and `motion` at 10, with the same verdicts (fail, fail, pass); a limit of 0.03 changes nothing for the two capped runs (iteration 20, the cap). `wl200` would stop at iteration 2 at either, with a loss of 0.0161.

Truth footprint r (median over all cells; each cell is compared with the truth unit of the nearest centroid, with one offset to the truth taken from the arm's Extract; this differs from rule 1, which matches by trace):

| recording | Discover's library (pass 1) | `raw` last pass | `f_chosen` iteration 1 | `f_chosen` at the stop | `f_chosen` highest   | stop minus iteration 1 | `f_chosen` at the stop minus `raw` last pass |
| --------- | --------------------------- | --------------- | ---------------------- | ---------------------- | -------------------- | ---------------------- | -------------------------------------------- |
| wl200     | 0.8621                      | 0.8605          | 0.8673                 | 0.8677                 | 0.8686 (iteration 3) | +0.0004                | +0.0072                                      |
| plain     | 0.9712                      | 0.9896          | 0.9862                 | 0.9899                 | 0.9899 (iteration 4) | +0.0037                | +0.0003                                      |
| motion    | 0.9402                      | 0.9325          | 0.9306                 | 0.9345                 | 0.9347 (iteration 4) | +0.0039                | +0.0020                                      |

That is the library median: at the stop `f_chosen` is at or above the last raw pass on all three (+0.0072, +0.0003, +0.0020). It is not the paired per-cell measure of the gate's report (truth footprint correlation, test minus reference, same cell, over the cells whose truth unit is found):

| recording | cells | median, `f_chosen` minus `raw` | 5th percentile |
| --------- | ----- | ------------------------------ | -------------- |
| wl200     | 25    | 0.0000                         | -0.0549        |
| plain     | 180   | 0.0000                         | -0.0118        |
| motion    | 145   | -0.0009                        | -0.0885        |

On the paired measure the median change is about 0 (not +0.0072 on `wl200`), and the lower tail is worse on `wl200` and `motion` than on `plain`. So a loss against `raw` is not shown to be harmless against the truth, nor to be harmful: the library median is at or above raw's, the tail of cells is worse. No truth exists for the WL24 recordings, where the failures are. After iteration 1 the truth r (library median) changes by at most 0.0041 on these three (`motion`: highest minus iteration 1), and by 0.0002 in the last iteration of `plain`. On `wl200` and on `motion` it is flat or moves up and down by under 0.005 from iteration 3 or 4 on, up to the cap on `motion` (0.9304 to 0.9347). On these three recordings nothing shows accuracy still rising after the stop, so nothing says the thresholds (0.99, 0.02) are too loose. Nothing is known for the WL24 recordings (no truth). The runs stop at the rule, so none shows what iterations past the stop would do on `plain` or `v4`.

### Per-iteration tables

Columns: the library (`raw` pass k, or `f_chosen`; its "pass 2" is Discover's finalised library after the compression replay), the changed share and the median of 1 - r of the changed cells against the library before, the accepted refinements of the iteration (the harness's count), the footprint loss against the final `raw` library over the QC-pass cells, and the truth footprint r median where there is a truth. A cell in only one library counts as changed (the cell count differs by one or a few between libraries on `plain` and `motion`).

**`wl200`**

| library                | changed share | median 1 - r of changed cells | accepted | footprint loss to the final `raw` | truth footprint r median |
| ---------------------- | ------------- | ----------------------------- | -------- | --------------------------------- | ------------------------ |
| `raw` pass 1           |               |                               |          | 0.0219                            | 0.8621                   |
| `raw` pass 2           | 0.3889        | 0.0461                        |          | 0.0133                            | 0.8585                   |
| `raw` pass 3           | 0.3889        | 0.0218                        |          | 0.0024                            | 0.8585                   |
| `raw` pass 4           | 0.1250        | 0.0175                        |          | 0.0005                            | 0.8605                   |
| `raw` pass 5           | 0.0278        | 0.0575                        |          | 0.0002                            | 0.8626                   |
| `raw` pass 6           | 0.0417        | 0.0264                        |          | 0.0000                            | 0.8605                   |
| `f_chosen` pass 1      |               |                               |          | 0.0219                            | 0.8621                   |
| `f_chosen` pass 2      | 0.0000        | n/a                           |          | 0.0219                            | 0.8621                   |
| `f_chosen` iteration 1 | 0.2222        | 0.0549                        | 26       | 0.0170                            | 0.8673                   |
| `f_chosen` iteration 2 | 0.0278        | 0.0607                        | 11       | 0.0161                            | 0.8675                   |
| `f_chosen` iteration 3 | 0.0417        | 0.0501                        | 8        | 0.0144                            | 0.8686                   |
| `f_chosen` iteration 4 | 0.0278        | 0.1091                        | 10       | 0.0132                            | 0.8679                   |
| `f_chosen` iteration 5 | 0.0694        | 0.0279                        | 12       | 0.0113                            | 0.8683                   |
| `f_chosen` iteration 6 | 0.0139        | 0.1476                        | 7        | 0.0113                            | 0.8677                   |

**`wl24_01`**

| library                 | changed share | median 1 - r of changed cells | accepted | footprint loss to the final `raw` |
| ----------------------- | ------------- | ----------------------------- | -------- | --------------------------------- |
| `raw` pass 1            |               |                               |          | 0.0698                            |
| `raw` pass 2            | 0.8529        | 0.0835                        |          | 0.0265                            |
| `raw` pass 3            | 0.6961        | 0.0271                        |          | 0.0119                            |
| `raw` pass 4            | 0.4118        | 0.0252                        |          | 0.0043                            |
| `raw` pass 5            | 0.3431        | 0.0322                        |          | 0.0022                            |
| `raw` pass 6            | 0.3039        | 0.0359                        |          | 0.0000                            |
| `f_chosen` pass 1       |               |                               |          | 0.0698                            |
| `f_chosen` pass 2       | 0.0000        | n/a                           |          | 0.0698                            |
| `f_chosen` iteration 1  | 0.5098        | 0.1434                        | 53       | 0.0419                            |
| `f_chosen` iteration 2  | 0.2647        | 0.0918                        | 29       | 0.0393                            |
| `f_chosen` iteration 3  | 0.2843        | 0.0634                        | 33       | 0.0362                            |
| `f_chosen` iteration 4  | 0.1373        | 0.0679                        | 19       | 0.0355                            |
| `f_chosen` iteration 5  | 0.1961        | 0.0357                        | 27       | 0.0362                            |
| `f_chosen` iteration 6  | 0.1275        | 0.0345                        | 16       | 0.0345                            |
| `f_chosen` iteration 7  | 0.1078        | 0.0693                        | 16       | 0.0362                            |
| `f_chosen` iteration 8  | 0.0588        | 0.0476                        | 13       | 0.0362                            |
| `f_chosen` iteration 9  | 0.0686        | 0.0769                        | 13       | 0.0362                            |
| `f_chosen` iteration 10 | 0.1078        | 0.0463                        | 16       | 0.0345                            |
| `f_chosen` iteration 11 | 0.0784        | 0.1002                        | 12       | 0.0334                            |
| `f_chosen` iteration 12 | 0.0980        | 0.0556                        | 15       | 0.0335                            |
| `f_chosen` iteration 13 | 0.1078        | 0.0479                        | 13       | 0.0345                            |
| `f_chosen` iteration 14 | 0.0588        | 0.0616                        | 10       | 0.0345                            |
| `f_chosen` iteration 15 | 0.0490        | 0.0643                        | 10       | 0.0345                            |
| `f_chosen` iteration 16 | 0.0490        | 0.0238                        | 9        | 0.0345                            |
| `f_chosen` iteration 17 | 0.0392        | 0.0602                        | 11       | 0.0345                            |
| `f_chosen` iteration 18 | 0.0392        | 0.0518                        | 11       | 0.0345                            |
| `f_chosen` iteration 19 | 0.0392        | 0.0159                        | 9        | 0.0345                            |
| `f_chosen` iteration 20 | 0.0294        | 0.0218                        | 8        | 0.0345                            |

**`wl24_04`**

| library                 | changed share | median 1 - r of changed cells | accepted | footprint loss to the final `raw` |
| ----------------------- | ------------- | ----------------------------- | -------- | --------------------------------- |
| `raw` pass 1            |               |                               |          | 0.0693                            |
| `raw` pass 2            | 0.8594        | 0.0559                        |          | 0.0299                            |
| `raw` pass 3            | 0.6406        | 0.0276                        |          | 0.0114                            |
| `raw` pass 4            | 0.3906        | 0.0209                        |          | 0.0063                            |
| `raw` pass 5            | 0.3438        | 0.0208                        |          | 0.0030                            |
| `raw` pass 6            | 0.3750        | 0.0212                        |          | 0.0000                            |
| `f_chosen` pass 1       |               |                               |          | 0.0693                            |
| `f_chosen` pass 2       | 0.0000        | n/a                           |          | 0.0693                            |
| `f_chosen` iteration 1  | 0.4062        | 0.1133                        | 27       | 0.0601                            |
| `f_chosen` iteration 2  | 0.1875        | 0.0777                        | 13       | 0.0562                            |
| `f_chosen` iteration 3  | 0.2344        | 0.0451                        | 17       | 0.0460                            |
| `f_chosen` iteration 4  | 0.1406        | 0.0489                        | 11       | 0.0421                            |
| `f_chosen` iteration 5  | 0.0781        | 0.1442                        | 6        | 0.0407                            |
| `f_chosen` iteration 6  | 0.2031        | 0.0474                        | 15       | 0.0426                            |
| `f_chosen` iteration 7  | 0.0625        | 0.0527                        | 6        | 0.0426                            |
| `f_chosen` iteration 8  | 0.0781        | 0.0209                        | 8        | 0.0426                            |
| `f_chosen` iteration 9  | 0.0625        | 0.0806                        | 7        | 0.0426                            |
| `f_chosen` iteration 10 | 0.0469        | 0.0300                        | 5        | 0.0426                            |
| `f_chosen` iteration 11 | 0.0781        | 0.0331                        | 8        | 0.0441                            |
| `f_chosen` iteration 12 | 0.0938        | 0.0260                        | 8        | 0.0441                            |
| `f_chosen` iteration 13 | 0.0469        | 0.0205                        | 5        | 0.0441                            |
| `f_chosen` iteration 14 | 0.0625        | 0.0287                        | 6        | 0.0388                            |
| `f_chosen` iteration 15 | 0.0469        | 0.0184                        | 5        | 0.0388                            |
| `f_chosen` iteration 16 | 0.0469        | 0.0165                        | 6        | 0.0388                            |
| `f_chosen` iteration 17 | 0.0312        | 0.1563                        | 7        | 0.0388                            |
| `f_chosen` iteration 18 | 0.0312        | 0.1390                        | 6        | 0.0390                            |
| `f_chosen` iteration 19 | 0.0000        | n/a                           | 4        | 0.0389                            |

**`plain`**

| library                | changed share | median 1 - r of changed cells | accepted | footprint loss to the final `raw` | truth footprint r median |
| ---------------------- | ------------- | ----------------------------- | -------- | --------------------------------- | ------------------------ |
| `raw` pass 1           |               |                               |          | 0.0236                            | 0.9712                   |
| `raw` pass 2           | 0.5344        | 0.0659                        |          | 0.0000                            | 0.9865                   |
| `raw` pass 3           | 0.1489        | 0.0356                        |          | 0.0000                            | 0.9896                   |
| `f_chosen` pass 1      |               |                               |          | 0.0236                            | 0.9712                   |
| `f_chosen` pass 2      | 0.0106        | 0.6567                        |          | 0.0236                            | 0.9715                   |
| `f_chosen` iteration 1 | 0.4840        | 0.0483                        | 115      | 0.0012                            | 0.9862                   |
| `f_chosen` iteration 2 | 0.1064        | 0.0433                        | 47       | 0.0009                            | 0.9890                   |
| `f_chosen` iteration 3 | 0.0479        | 0.0447                        | 33       | 0.0009                            | 0.9897                   |
| `f_chosen` iteration 4 | 0.0160        | 0.0438                        | 22       | 0.0009                            | 0.9899                   |

**`v4`**

| library                | changed share | median 1 - r of changed cells | accepted | footprint loss to the final `raw` |
| ---------------------- | ------------- | ----------------------------- | -------- | --------------------------------- |
| `raw` pass 1           |               |                               |          | 0.0796                            |
| `raw` pass 2           | 0.8493        | 0.0973                        |          | 0.0005                            |
| `raw` pass 3           | 0.3744        | 0.0480                        |          | 0.0000                            |
| `f_chosen` pass 1      |               |                               |          | 0.0796                            |
| `f_chosen` pass 2      | 0.0000        | n/a                           |          | 0.0796                            |
| `f_chosen` iteration 1 | 0.6119        | 0.0895                        | 136      | 0.0227                            |
| `f_chosen` iteration 2 | 0.1781        | 0.0589                        | 46       | 0.0224                            |
| `f_chosen` iteration 3 | 0.1096        | 0.0530                        | 30       | 0.0195                            |
| `f_chosen` iteration 4 | 0.0685        | 0.0552                        | 20       | 0.0189                            |
| `f_chosen` iteration 5 | 0.0137        | 0.0175                        | 6        | 0.0189                            |

**`motion`**

| library                 | changed share | median 1 - r of changed cells | accepted | footprint loss to the final `raw` | truth footprint r median |
| ----------------------- | ------------- | ----------------------------- | -------- | --------------------------------- | ------------------------ |
| `raw` pass 1            |               |                               |          | 0.1123                            | 0.9402                   |
| `raw` pass 2            | 0.9122        | 0.1216                        |          | 0.0059                            | 0.9317                   |
| `raw` pass 3            | 0.4122        | 0.0258                        |          | 0.0000                            | 0.9325                   |
| `f_chosen` pass 1       |               |                               |          | 0.1123                            | 0.9402                   |
| `f_chosen` pass 2       | 0.0267        | 0.3595                        |          | 0.1082                            | 0.9393                   |
| `f_chosen` iteration 1  | 0.6947        | 0.1097                        | 188      | 0.0293                            | 0.9306                   |
| `f_chosen` iteration 2  | 0.3435        | 0.0438                        | 113      | 0.0189                            | 0.9297                   |
| `f_chosen` iteration 3  | 0.2443        | 0.0336                        | 97       | 0.0169                            | 0.9305                   |
| `f_chosen` iteration 4  | 0.1603        | 0.0373                        | 73       | 0.0161                            | 0.9347                   |
| `f_chosen` iteration 5  | 0.0992        | 0.0299                        | 56       | 0.0172                            | 0.9327                   |
| `f_chosen` iteration 6  | 0.0878        | 0.0221                        | 58       | 0.0172                            | 0.9343                   |
| `f_chosen` iteration 7  | 0.0840        | 0.0264                        | 53       | 0.0172                            | 0.9345                   |
| `f_chosen` iteration 8  | 0.0573        | 0.0212                        | 46       | 0.0175                            | 0.9345                   |
| `f_chosen` iteration 9  | 0.0725        | 0.0277                        | 53       | 0.0179                            | 0.9342                   |
| `f_chosen` iteration 10 | 0.0458        | 0.0299                        | 38       | 0.0190                            | 0.9340                   |
| `f_chosen` iteration 11 | 0.0458        | 0.0586                        | 35       | 0.0190                            | 0.9345                   |
| `f_chosen` iteration 12 | 0.0382        | 0.0140                        | 35       | 0.0198                            | 0.9345                   |
| `f_chosen` iteration 13 | 0.0496        | 0.0339                        | 46       | 0.0197                            | 0.9304                   |
| `f_chosen` iteration 14 | 0.0458        | 0.0229                        | 45       | 0.0194                            | 0.9324                   |
| `f_chosen` iteration 15 | 0.0458        | 0.0384                        | 40       | 0.0186                            | 0.9345                   |
| `f_chosen` iteration 16 | 0.0420        | 0.0296                        | 38       | 0.0179                            | 0.9345                   |
| `f_chosen` iteration 17 | 0.0305        | 0.0288                        | 36       | 0.0176                            | 0.9345                   |
| `f_chosen` iteration 18 | 0.0344        | 0.0248                        | 35       | 0.0177                            | 0.9345                   |
| `f_chosen` iteration 19 | 0.0382        | 0.0544                        | 36       | 0.0182                            | 0.9345                   |
| `f_chosen` iteration 20 | 0.0229        | 0.0269                        | 32       | 0.0177                            | 0.9345                   |

The footprint file of `raw` (`footprints.bin`) is not byte-identical to its last pass library on four recordings (`wl24_01`, `plain`, `v4`, `motion`); the median loss between them is 0.0000 to four decimals on all six. The table uses the last pass library for the `raw` rows and `footprints.bin` for the reference.

## Missing pixels and skipped tiles

`low_valid` in `iterations.tsv` counts the cells whose smallest valid share, over every pixel of the cell's statistics disk and every window of the iteration, is below 0.999 (1 up to rounding). A pixel with a valid share below 0.1 in a window is left out of that window's statistics, and a pixel from 0.1 up to 1 enters with the window mean as data; the count includes both kinds (pixels below 0.1 count too). It names no cells. `tiles_skipped` counts slow-loop tiles that have cells but fewer than 8 held-out frames; their cells are not refined in that iteration.

| recording | `low_valid`: first / largest / last iteration | tiles skipped, all iterations | cells |
| --------- | --------------------------------------------- | ----------------------------- | ----- |
| wl200     | 0 / 0 / 0                                     | 0                             | 72    |
| wl24_01   | 1 / 3 / 3                                     | 0                             | 102   |
| wl24_04   | 3 / 3 / 3                                     | 0                             | 64    |
| plain     | 0 / 0 / 0                                     | 0                             | 188   |
| v4        | 0 / 0 / 0                                     | 0                             | 219   |
| motion    | 0 / 0 / 0                                     | 0                             | 262   |

No tile was skipped in any iteration. `low_valid` is 0 on four recordings, 1 to 3 cells on `wl24_01` and 3 on `wl24_04`. Cells with a valid share between 0.1 and 1 are not corrected: the window mean pulls their estimate toward 0 by about the missing share. The two recordings where the count is not 0 are the two that fail rule 2; with 3 cells in 102 and in 64 it cannot explain a median loss over 58 and 40 cells (inferred). Which cells were flagged was not written, so their footprints were not looked at.

## Cost

All times are indicative. The first 40 minutes of the series (until about 02:20) overlapped with other runs (up to five or six harness processes at once), and a browser run started at 02:18. Wall seconds and peak memory are not timing results.

One iteration, seconds (median over the iterations; `iterations.tsv`):

| recording | iterations | read s | sums s | held-out patches s | gate s | publish s | wall s: first / median / last | all iterations, wall s |
| --------- | ---------- | ------ | ------ | ------------------ | ------ | --------- | ----------------------------- | ---------------------- |
| wl200     | 6          | 0.03   | 0.65   | 0.15               | 0.11   | 0.01      | 0.76 / 0.95 / 0.80            | 6                      |
| wl24_01   | 20         | 0.05   | 1.52   | 0.29               | 0.35   | 0.01      | 1.49 / 2.26 / 2.91            | 45                     |
| wl24_04   | 19         | 0.04   | 0.55   | 0.14               | 0.11   | 0.01      | 0.80 / 0.84 / 0.86            | 16                     |
| plain     | 4          | 0.11   | 0.64   | 0.73               | 0.17   | 0.03      | 1.78 / 1.70 / 1.66            | 7                      |
| v4        | 5          | 0.16   | 1.12   | 0.69               | 0.20   | 0.03      | 2.24 / 2.20 / 2.17            | 11                     |
| motion    | 20         | 0.13   | 1.08   | 0.86               | 0.54   | 0.04      | 2.38 / 2.65 / 2.70            | 52                     |

Per iteration the sums (statistics from the factors, and the traces) are the largest part at 200 px (median 0.55 to 1.52 s of a median wall of 0.84 to 2.26 s); at 600 px the sums (0.64 to 1.12 s) and the held-out patches (0.69 to 0.86 s) are of a size. On `wl24_01` the iterations got slower during the run (1.49 s first, 2.91 s last) with the same work, which fits the load of the time (inferred).

The arm, against `raw`:

| recording | `raw` arm wall s | `f_chosen` arm wall s | `f_chosen` pass 1 (Discover) s | pass 2 (compression replay) s | iterations s | Extract on factors s | pass 2 as percent of the arm wall | `raw` Refine passes s | `raw` Extract s | peak memory MB, `raw` / `f_chosen` |
| --------- | ---------------- | --------------------- | ------------------------------ | ----------------------------- | ------------ | -------------------- | --------------------------------- | --------------------- | --------------- | ---------------------------------- |
| wl200     | 303              | 118                   | 65                             | 46                            | 6            | 0.5                  | 39                                | 221 (5 passes)        | 16              | 242 / 869                          |
| wl24_01   | 394              | 156                   | 69                             | 39                            | 45           | 1.7                  | 25                                | 302 (5 passes)        | 19              | 271 / 859                          |
| wl24_04   | 349              | 124                   | 68                             | 39                            | 16           | 0.5                  | 31                                | 259 (5 passes)        | 18              | 246 / 857                          |
| plain     | 388              | 312                   | 138                            | 163                           | 7            | 0.5                  | 52                                | 185 (2 passes)        | 59              | 1161 / 2250                        |
| v4        | 430              | 381                   | 142                            | 225                           | 11           | 1.0                  | 59                                | 220 (2 passes)        | 61              | 1050 / 2229                        |
| motion    | 405              | 359                   | 141                            | 160                           | 52           | 0.9                  | 45                                | 197 (2 passes)        | 63              | 1122 / 2323                        |

- **Arm wall, `f_chosen` against `raw`:** 118 against 303, 156 against 394, 124 against 349 s at 200 px (about 0.4); 312 against 388, 381 against 430, 359 against 405 s at 600 px (0.80 to 0.89).
- **`f_chosen` needs the compression replay (pass 2).** It reads the raw file again, preprocesses it and compresses it; that is 25 to 59 percent of the arm wall (39 percent on `wl200`, 25 and 31 on the WL24 recordings, 52, 59 and 45 on `plain`, `v4`, `motion`). On `wl24_01` pass 2 took 39 s (13.7 preprocessing, 25.5 compressing); on `plain` 163 s (55.7 and 106.9).
- **Refine part against the raw passes:** at 200 px the compression replay plus the iterations take 52, 84 and 55 s, against 221, 302 and 259 s for the five raw Refine passes. At 600 px they take 170, 236 and 212 s against 185, 220 and 197 s for two raw passes: no saving, since the raw reference there is only 2 passes (a settled raw Refine would cost more; not measured).
- **Extract on factors** takes 0.5 to 1.7 s against 16 to 63 s for the raw Extract (as phase 2).
- **Memory:** `f_chosen` peaks at 857 to 869 MB at 200 px (raw 242 to 271) and at 2229 to 2323 MB at 600 px (raw 1050 to 1161).

The iterations themselves are 2 to 14 percent of the arm wall (6 to 52 s) on five recordings and 29 percent on `wl24_01` (45 s). Most of the rest is Discover (pass 1) and the compression replay (pass 2), which read and preprocess the raw file as a raw pass does (inferred from the stage times: no arm isolates it).

## `f_null` against `f_chosen` on `plain`

The tool's line: "`f_null` repeats `f_chosen` with another later budget; a factor Refine uses no budget, so this is a repeat run: footprints identical to `f_chosen`: yes." Recomputed from the files: `footprints.bin`, `extract_trace.f32`, `final.tsv`, all four `footprints_iter{k}.bin`, the ten window files of the compression replay and every column of `iterations.tsv` except the seconds are the same bytes or values. Both arms took 312 s.

What it shows: the compression replay and the factor Refine are deterministic on this recording (two runs, equal to the byte) and the later budget has no effect on a factor Refine. It does not show that the result is independent of machine speed: both runs ran at about the same time on the same machine, and a factor Refine has no time-dependent input in its code (no clock, no budget; read in the whole-phase review).

## What differs from the spec

Each point is a decision made in the plan or in a review ruling. All are for the owner.

- **Held-out comparison on rebuilt tile patches, not on projections.** Spec 5, step 3, says the held-out comparison is "fed with projections from the factors". The iteration rebuilds, for each slow-loop tile, the patches of `K` held-out frames from the factors and feeds the existing gate. Cost if wrong: the projection route (bump maps and patch energy through the spatial factors) is a new function. For the owner.
- **Which held-out frames.** The raw reservoir picks about `frames_per_tile / holdout_every` held-out frames per tile, 70 percent by the residual's excursions and 30 percent uniformly. The factor route has no residual image: it picks by the activity of the cells in the tile plus a hash of the frame index, tile and seed, and stores the patches in the raw reservoir's quantised form (16-bit, step 1/16 sigma, clamp at 2048 sigma, its missing marker), so that the gate reads the same kind of value. `--test-frames` 0 gives the reservoir's average. For the owner.
- **The held-out split rotates between iterations,** as it does between raw Refine passes (a frame counter that advances by the recording's length): in the next iteration a frame that was held out is fitted on. The gate is therefore not out of sample over a whole run, on either route (measured in the Task 4 review: 332 of 487 frames held out in iteration 1 were fitting frames in iteration 2). The alternative, a fixed split on both routes, is about ten lines. For the owner.
- **Split into 3a and 3b.** 3a (built) has the per-cell statistics route and the gate with the joint flags off. 3b (cluster history replay on factors, A8) is planned and not built; the iteration refuses `joint_update` other than off and `core_test` other than off. A11's gate asks for both; only the flags-off half was run. For the owner.
- **The settle measure.** The spec does not define "correlates below 0.99": it is the Pearson correlation of the unfiltered footprints over the union of both supports (a pixel outside a support counts 0), per cell by id, and a cell in only one library counts as changed. For the owner.
- **Pixels with few valid samples.** A pixel with a valid share below 0.1 in a window is left out of that window's statistics (as a pixel missing in every frame is on the frame route); from 0.1 to 1 the window mean enters as data. Spec 1 and A8 say the second part differently for the cluster replay (3b). For the owner.
- **Reference.** The spec says a raw Refine repeated until settled (5 passes); this run has 5 passes at 200 px and 2 at 600 px, not settled (see 1(c)). Only the default settle thresholds were run (the tool refuses the settle flags in `--extra`), although the spec says they are "checked in phase 3". For the owner.
- **No forgetting.** The factor iteration weights every fitting frame 1 in the footprint statistics (the library is fixed within an iteration, so the spec says the statistics need no half-life); the raw Refine forgets with a half-life. The spec lists the missing half-life as a difference "to be measured"; it was not measured separately, and it is a candidate cause of the WL24 plateau. For the owner.
- **The statistics path for every cell** (the spec lists it) and **the noise map fixed once** after the compression replay (a raw pass refreshes it every 200 frames) are as the plan's design notes say.

## How it was measured

- **Provenance.** `factor_arms.py` ran `qc_eval` once per arm and recording, from the script `run_3a.sh` in the run folder, with the log `run_3a.log`: all 22 arms ended with return code 0. The harness was built from commit bfc820a9 in its own target folder. The `report.md` files were rebuilt for this report with the six commands of `run_3a.sh` unchanged; every arm was finished, so no arm was rerun and only the reports were rebuilt.
- **Scale, as in phases 1 and 2.** `wl200`, `wl24_01`, `wl24_04`: first 12000 frames, 5 Refine replays in `raw`, 3 runs at once. `plain`, `v4`, `motion`: first 6000 frames, 2 Refine replays, 2 runs at once. Slow-loop budget 3,000,000 work units per frame (a tenth of the default) on every arm; `null_lo` and `null_hi` used 1,500,000 and 6,000,000 in the replays. `--truth` on `wl200`, `plain` and `motion`.
- **`raw`:** `--passes 6` (200 px) or `--passes 3` (600 px), `--later-passes refine --extract-pass --motion`.
- **`f_chosen`:** `--passes 2 --later-passes refine --refine-engine factors --extract-engine factors --replay-source factors --tiling offset --factors-pass 2 --extract-pass --motion` and `--factors-out`. Pass 1 is Discover; pass 2 is a compression replay only (offset grids, recalibrated factors written during it); then the iterations (defaults: `--settle-corr` 0.99, `--settle-share` 0.02, `--max-iterations` 20, `--test-frames` 0, joint flags off); then Extract on the factors with the settled library. `f_null` adds `--later-budget`.
- **Identity check (before the runs, on `wl200`, first 1800 frames).** With this phase's harness, the arm `chosen` and main's look-back arm give the same traces and footprints, and `chosen` the same three factor windows, as the reference runs of phase 4a (made before this phase): same bytes, compared again for this report. The compression-only pass 2 of a factor-Refine run writes window files with the same bytes as the existing replay pass (three windows, compared again). The same check at the earlier commit eb981092 gave the same result; the fix wave after bfc820a9 did not change the harness's behaviour (doc comments, one refusal, one removed duplicate check).
- **Numbers.** Every number in this report was computed by scripts over the run folder's files (the `report.md` files, `iterations.tsv`, `stage_times.tsv`, `run.json`, the footprint libraries of every pass and iteration, the window files and the byte comparisons), not copied by hand. Phase 1's numbers are read from its run folder's reports.

## What was not measured

- The joint flags (3b), and the gate A1 with them on (A11 asks for both).
- Whole recordings and the full slow-loop budget: runs are the first 12000 or 6000 frames at a tenth of the default budget.
- A raw Refine run until it settles, at either scale; at 600 px the reference had 2 replays.
- Non-default settle thresholds, cap or `--test-frames` (the tool refuses these flags in `--extra`).
- More than one background model on data (the runs have the default model; two or three are covered by the unit tests only).
- A short last window in a run (12000 / 600 and 6000 / 600 divide exactly); the unit tests and a scratch run cover it.
- The browser, a live stream and the app (phase 4).
- Run times under no other load; the per-cell direction of the late footprint changes; which cells `low_valid` flagged.
- Whether the unit tests still pass at HEAD: not run for this report.
