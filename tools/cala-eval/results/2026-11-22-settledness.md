# Per-cell settledness and Final-settle stop levels (22 Nov 2026)

This is an offline study of PR #464's saved runs. Nothing new was run.

- The measures, stop grid, scoring and level rule were committed before any quality number was computed:
  [plan](2026-11-22-settledness-plan.md), commit `82a13823`.
- Anything added later is marked **(after the runs)**.
- All generated tables: [2026-11-22-settledness-tables.md](2026-11-22-settledness-tables.md).
- Script: [`settledness.py`](../settledness.py) (`dist`, `score`, `strided`). It takes about 2 min and stays under
  0.7 GB.

**Data**

| set  | what                                                              | runs |
| ---- | ----------------------------------------------------------------- | ---- |
| real | Samara `10_43_21` and `14_57_02`; arms Max, P-30, S-30; seeds 1-3 | 18   |
| sims | pairs 5, 6 and static 5, 6, 7; three arms each; with ground truth | 15   |

- Real runs that share a recording are not independent, so their intervals are too narrow.
- Every run saved its in-order full Final settle as a library every 1,200 frames.
- "Stopping at checkpoint c" means taking that library.

**References**

- **Real:** the other two seeds' Max `B100`. This reference is itself read in order and was still rising at the end of
  the pass, so it favours the full pass. Split-half footprints were not saved, so no order-free real reference exists.
- **Sims:** truth.

## Short answers for the PI

1. **Library footprints change in jumps, not continuously.**
   - A footprint changes only when a refine is committed.
   - From one checkpoint to the next, 34 % of cells do not change at all (38 % on sims).
   - Over three checkpoints (3,600 frames), about a third of cells do not change at all.
   - This is not explained by a quiet cell. Among cells that had events in the span, 33 % did not change; among cells
     without events, 36 %.
   - So the PI's observation is literal. Many late updates are no update. Most of the rest are small wobble.
2. **Per-cell measures carry some information. Step size on the edge ring does as well as any.**
   - **Measure M2 ("drift")** keeps only the steady, same-direction part of a cell's last three steps. It is computed
     separately for the core and for an edge ring that includes the empty pixels next to the footprint.
   - On a planted test M2 behaves as the PI asked:
     - pure wobble scores 0;
     - a bite filling in scores 0.10, even with a smaller step than the wobble;
     - a slowly growing edge scores 0.05.
   - **On the runs, the question is how much more the 10 % of cells a measure flags most still gain than the other
     cells.** Gains are signed, mean over checkpoints, then over runs:

     | measure                                             | real: cosine gain vs Max | sims: edge-error drop  | sims: r gain           |
     | --------------------------------------------------- | ------------------------ | ---------------------- | ---------------------- |
     | M1, whole-footprint step                            | +0.015 [0.013, 0.018]    | +0.013 [0.006, 0.019]  | +0.004 [0.002, 0.007]  |
     | **edge-ring step** (after the runs; edge-ring norm) | +0.014 [0.012, 0.017]    | +0.013 [0.007, 0.020]  | +0.004 [0.002, 0.007]  |
     | M2 drift                                            | +0.012 [0.009, 0.014]    | +0.002 [-0.003, 0.007] | +0.001 [-0.000, 0.002] |
     | share of the cell's life re-read (after the runs)   | +0.009 [0.007, 0.010]    | +0.019 [0.012, 0.027]  | +0.005 [0.003, 0.007]  |
     - For scale, the remaining library-wide gain is about 0.003 in median cosine (real) and 0.005-0.01 in median
       edge error (sims). So the flagged cells are the ones still improving.
     - Ranked over all cells, every measure is weak: Spearman 0.10-0.18 on real, at most 0.05 on sims.
     - On sims, the direction measure is no better than chance at edges.

   - **Edge repairs are not a slow, steady drift.**
     - Sims have 708 bites that heal during the pass. 204 of them heal after checkpoint 3, where the measures exist.
     - For those 204, the median bite ratio is 0.00 at each of the three checkpoints before the heal, and 0.68 at the
       checkpoint where it heals.
     - So the bitten pixel enters the footprint within one 1,200-frame interval, not gradually.
     - Healing cells do move more beforehand. 40 % are above step 0.08, against 11 % of all cells. 32 % are above
       drift 0.01, against 11 %. 23 % had no committed change in the window, against 35 % of all cells.
3. **Stop rules: no clear advantage over a fixed in-order stop.**
   - The test covered all 14 pre-registered rules (measure x threshold x settled share of 80-95 %).
   - Each was compared with a fixed stop at the same mean frames, paired per run.
   - **Real:** no rule differs from fixed in any metric (all CIs include 0).
   - **Sims:** it depends on how the fixed stop is placed between the coarse sims checkpoints, every 12.5 %:
     - fixed rounded up (reads more): the rules are level or slightly worse;
     - fixed interpolated: the rules are slightly better on edge error, by 0.001-0.003. Two rules are significantly
       better there and worse nowhere: M2 0.01 / 90 % and M2b 0.08 / 90 %.
   - Several rules stop at the earliest allowed checkpoint on almost every sim: 12-15 of 15 for M1 0.08 and 0.12 at
     80 %. That is not evidence of adaptivity.
   - So any gain from an adaptive stop is no larger than about 0.003 in edge error. The sims are too coarse to say more.
4. **Why a share-of-settled stop doesn't help much (partly tested).**
   - Stopping an in-order pass early always skips re-reading the end of the recording, whichever cells look settled.
   - Cells born in the second half of Discover lose 5-10x the library's footprint r at any early stop. Two readings
     fit this: those frames were never re-read, or these cells simply start further from their end state.
   - **(After the runs)** #464's strided budgets read the same number of frames spread over the recording. Against
     truth on sims they end slightly better than in-order truncation:
     - footprint r +0.0012 at a quarter of a pass and +0.0006 at half;
     - median edge error 0.0055 lower at both.

     At three quarters neither difference is significant. Bites and late-born cells are not significantly different
     at any budget. On real, against Max (which is read in order), strided is level or slightly worse.

   - So read order explains part of it, not all.
5. **Levels.** By the pre-registered rule, fixed budgets win, because no adaptive rule beats them:

   | level        | Final settle                         | frames saved (real / sims) | real loss vs Max: median / 10th-pct cosine | sims loss vs truth: r / edge error / bitten share | sims late-born r loss | sims bites left unhealed |
   | ------------ | ------------------------------------ | -------------------------- | ------------------------------------------ | ------------------------------------------------- | --------------------- | ------------------------ |
   | **Thorough** | full pass                            | 0 / 0 %                    | 0 / 0                                      | 0 / 0 / 0                                         | 0                     | 0 of 643                 |
   | **Standard** | stop after 87 % of the pass in order | 13 / 12 %                  | 0.0004 / -0.0005                           | 0.0003 / 0.0005 / 0.005                           | 0.004                 | 42 of 643                |
   | **Quick**    | stop after 60 % of the pass in order | 40 / 38 %                  | 0.0028 / 0.0079                            | 0.0009 / 0.0055 / 0.012                           | 0.007                 | 92 of 643                |
   - "Bites left unhealed" = bites open at the stop that the full pass heals. For scale, 643 bites open at the start
     of the pass heal by its end.
   - By the plan rule:
     - The top Quick-passing rule is M1 0.08 / 80 %. It saves 38 % real and 62 % sims (mostly the earliest stop), but
       does not beat fixed at its frames, so the fixed budget is preferred.
     - The one Quick-passing rule that does beat fixed (M2 0.01 / 90 %) saves only 11 % real and 46 % sims.
     - The Standard-passing rule (M2 0.01 / 95 %) never fires on real.
   - The 87 % and 60 % stop points were picked in-sample, from these two recordings and five sims.
   - Sims stop points come every 12.5 % of the pass, so their rows round up: Standard reads 88 % and Quick 62.5 %.
   - Tolerances (plan):
     - Standard: real 0.001 / 0.003 / 1 point; sims 0.001 r / 0.005 edge / 0.01 bitten.
     - Quick: real 0.003 / 0.01 / 3 points; sims 0.003 / 0.015 / 0.03.
   - The next earlier stops fail on real median cosine: Standard at 81 % (0.0010), Quick at 54 % (0.0032).
   - **Per arm, Quick costs P-30 the most bites on sims:** bitten share +0.021 (CI 0.005-0.036), against +0.011 for
     Max and +0.003 for S-30, n = 5 each.
   - **Recommendation:**
     - Keep **Thorough** as the default.
     - If the PI wants options, Quick is honest as "about 40 % faster; slightly rougher edges, late-born cells and a
       few unfilled bites."
     - Standard saves about an eighth of the pass. It is only worth offering if the PI wants a middle step.

6. **The per-cell settledness number for the UI.**
   - The data support a **"still moving" indicator** built from recent step size. In the app, divide it by
     split-half noise, as `settle.ts` does.
   - To meet the PI's edge requirement, take the **edge-ring step** separately, each region against its own norm, and
     show the larger of edge and core. It ranks cells as well as the whole-footprint step and does not let the core
     drown the edge.
   - The 10 % of cells it flags most still gain clearly more than the rest. Most cells that still improve are not
     flagged.
   - The direction measure (M2) matches "edge work" on paper. It adds nothing here, because edge repairs arrive
     within one checkpoint interval.
   - I would not stop the Final settle by any of them alone.

## What would make a per-cell stop work (not tested here)

- **Change where the settle reads, not only when it stops.**
  - A per-cell saving needs a settle that re-reads the frames where unflagged-but-unhealed cells are active.
  - That means need-driven reading, like #462's look-back pool. An in-order sweep cannot do it.
  - Strided reading already helps a little on sims (answer 4).
- **Next study:** strided or need-driven settle runs that save checkpoint libraries. Score M1, and coverage of each
  cell's active frames, against truth.
- **Use the engine's own noise and gate.**
  - Per-cell split-half noise (`SlowLoop.footprintNoise`) was not saved per checkpoint, so M1 here uses the
    footprint's own scale. In the app, divide by the split-half noise, as `settle.ts` already does.
  - "Committed changes in the last N checks" is free online and is the same information as M1's zero / non-zero part.

## Details

### Measures (from the plan)

- Footprints are scaled to unit L2 norm.
- The window is the last 4 checkpoints, which is 3 steps.
- Regions:
  - core = pixels at or above half the peak;
  - edge = the window's union support, dilated by 2 px, minus the core.
- A cell counts as **settled** when its value is below tau.
- Cells that are new to the window count as **not settled**.
- The first possible stop is checkpoint 3: 20 % of the pass on real, 37.5 % on sims.

| measure    | what it is                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 `step`  | Size of the last step, relative to the footprint.                                                                                                                                                                                    |
| M2 `drift` | Per region: sqrt(max(0, sum over pairs i<j of d_i·d_j) / 3), divided by the region's norm. The cell takes the larger of core and edge. Wobble scores about 0 at any size. Steady growth or shrinkage scores its rate per checkpoint. |
| M2b `ucb`  | M2 with a 2-sd bound under random step-sign flips. It correlates 0.74 with M1.                                                                                                                                                       |

### Selected stop rules

Mean frames saved; mean loss [95 % t CI]; n = 18 real, 15 sims.

| rule                  | saved real / sims | real median cos         | real 10th-pct cos       | sims r                   | sims edge error          | sims bitten share     |
| --------------------- | ----------------- | ----------------------- | ----------------------- | ------------------------ | ------------------------ | --------------------- |
| M1 0.08, 80 % settled | 38 / 62 %         | 0.0025 [0.0015, 0.0035] | 0.0074 [0.0027, 0.0122] | 0.0023 [0.0015, 0.0032]  | 0.0107 [0.0059, 0.0154]  | 0.025 [0.014, 0.036]  |
| M2 0.02, 90 %         | 36 / 56 %         | 0.0022 [0.0016, 0.0029] | 0.0064 [0.0034, 0.0094] | 0.0019 [0.0013, 0.0026]  | 0.0088 [0.0049, 0.0128]  | 0.022 [0.011, 0.032]  |
| M2 0.03, 95 %         | 25 / 44 %         | 0.0014 [0.0008, 0.0019] | 0.0030 [0.0004, 0.0056] | 0.0011 [0.0005, 0.0017]  | 0.0049 [0.0017, 0.0081]  | 0.014 [0.006, 0.022]  |
| M2 0.01, 95 %         | 0 / 20 %          | 0 (never fires on real) | 0                       | 0.0002 [-0.0001, 0.0006] | 0.0021 [-0.0003, 0.0045] | 0.005 [-0.001, 0.011] |

- **Plan rule.** M1 0.08 / 80 % passes Quick, and M2 0.01 / 95 % passes Standard. M2 0.01 / 95 % saves nothing on
  real. Neither beats a fixed stop at the same frames (answer 3).
- **Unsettled cells carry more of the loss.** On sims, cells flagged unsettled at an M1 or M2b stop carry 3-6x the
  edge-error loss of settled cells. M2's flagged cells do not separate this way.
- **Late-born cells lose 0.009-0.017 in r** at stops that save a third of the pass or more. The library as a whole
  loses 0.001-0.003.

### Caveats

- The real reference favours the full pass (see above). The sims use truth and agree in direction.
- Sims have only 8 checkpoints of 9,600 frames, so their stops are coarse.
- The thresholds were chosen from the measure distributions only. A different grid would stop elsewhere. Since no
  rule beat fixed truncation, tuning could at best match it.
- **Changes after the plan:**
  - Added after the first scoring pass:
    - the fixed stops at every checkpoint, compared frame-matched;
    - the per-arm table;
    - the top-10 % gain table;
    - the edge-ring and core step;
    - the zero-step activity check;
    - the bite trajectories.
  - The real reference was corrected to exclude the run's own seed for every arm, as the plan says. The first pass
    pooled the same-seed Max for P-30 and S-30. That moved the numbers by at most 0.0003.
- **Checks (after the runs).**
  - The truth scoring was reimplemented without `compute_run`. On two sims it matches `B100/demix_cells.tsv` (mean
    r equal to 4 decimals) and `demix_pairs.tsv` (bitten share equal).
  - Losses are taken against the last checkpoint library. It differs slightly from the final `footprints.bin`: 86-92 %
    of cells are identical, minimum cosine 0.983.
- **Not done:** what a 0.003 cosine loss does to the traces. Traces were not saved per checkpoint, so there is no
  cheap version.
