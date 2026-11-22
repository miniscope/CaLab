# Per-cell settledness and Final-settle stop levels (22 Nov 2026)

This is an offline study of PR #464's saved runs. Nothing new was run.

- The measures, stop grid, scoring and level rule were committed before any quality number was computed:
  [plan](2026-11-22-settledness-plan.md), commit `82a13823`.
- Anything added later is marked **(after the runs)**.
- All generated tables: [2026-11-22-settledness-tables.md](2026-11-22-settledness-tables.md).
- Script: [`settledness.py`](../settledness.py) (`dist`, `score`, `strided`). It takes about 2 min and stays under
  0.7 GB.

**Data**

| set  | what                                                                    | runs |
| ---- | ----------------------------------------------------------------------- | ---- |
| real | Samara `10_43_21` and `14_57_02`; arms Max, P-30, S-30; seeds 1-3        | 18   |
| sims | pairs 5, 6 and static 5, 6, 7; three arms each; with ground truth        | 15   |

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
2. **Every per-cell measure carries some information, but plain step size beats the direction measure.**
   - **Measure M2 ("drift")** keeps only the steady, same-direction part of a cell's last three steps. It is computed
     separately for the core and for an edge ring that includes the empty pixels next to the footprint.
   - On a planted test M2 behaves as the PI asked:
     - pure wobble scores 0;
     - a bite filling in scores 0.10, even with a smaller step than the wobble;
     - a slowly growing edge scores 0.05.
   - **On the runs, the question is how much of the remaining improvement the 10 % of cells a measure flags most
     carry.** (With no information they would carry 10 %.)

     | measure                                | real, cosine vs Max | sims, edge error | sims, total error |
     | -------------------------------------- | ------------------- | ---------------- | ----------------- |
     | M1 (size of the last step)             | 30 %                | 25 %             | 34 %              |
     | M2 (drift)                             | 26 %                | 19 %             | 23 %              |

     - For both measures the flagged cells hold 2-3x their share.
     - Ranked over all cells, both are weak: Spearman 0.10-0.18 on real, at most 0.05 on sims.
   - **Real edge work is not a slow, steady drift.**
     - Sims have 204 bitten neighbour pairs that heal during the pass. Their median bite ratio over the three
       checkpoints before the heal is 0.00 → 0.00 → 0.00, then 0.68 at the heal.
     - So the bite fills in **one commit**. The bitten pixel enters the support at once.
     - Healing cells do move more beforehand. 32 % are above drift 0.01, against 11 % of all cells. 40 % are above
       step 0.08, against 11 %.
     - So the measures raise the odds of catching a heal by about 3x, but most heals come without warning.
3. **No stop rule beat stopping the in-order pass at a fixed point.**
   - The test covered all 14 pre-registered rules (measure x threshold x settled share of 80-95 %).
   - Each rule was compared with a fixed stop that saves the same mean frames, paired per run.
   - None was better on both real and sims. The differences are small:
     - median cosine within ±0.0006 (real);
     - 10th-percentile cosine within ±0.002 (real);
     - footprint r within ±0.0007 and edge error within ±0.0024 (sims).
   - Of the 84 comparisons, the few that are significant mostly favour the fixed stop. Example: M1 at 0.08 / 80 %
     costs +0.0007 r on sims (CI 0.0003-0.0012).
   - The one exception is M2b at 0.08 / 90 %:
     - better on sims edge error, -0.0024 (CI -0.0047 to -0.0002);
     - worse on real 10th-percentile cosine, +0.0020 (CI 0.0002-0.0037).

     That is what chance gives over 84 comparisons.
4. **Why a share-of-settled stop doesn't help (partly tested).**
   - Stopping an in-order pass early always skips re-reading the end of the recording, whichever cells look settled.
   - Cells born in the second half of Discover lose 5-10x the library's footprint r at any early stop. Two readings
     fit this: those frames were never re-read, or these cells simply start further from their end state.
   - **(After the runs)** #464's strided budgets read the same number of frames spread over the recording. Against
     truth on sims they end slightly better than in-order truncation:
     - footprint r +0.0012 at a quarter of a pass and +0.0006 at half;
     - median edge error 0.0055 lower at both.

     At three quarters neither difference is significant. Bites and late-born cells are not significantly different at
     any budget. On real, against Max (which is read in order), they
     are level or slightly worse.
   - So read order explains part of it, not all.
5. **Levels.** By the pre-registered rule, fixed budgets win, because no adaptive rule beats them:

   | level        | Final settle                         | frames saved (real / sims) | real loss vs Max: median / 10th-pct cosine | sims loss vs truth: r / edge error / bitten share | sims late-born r loss | sims bites left unhealed |
   | ------------ | ------------------------------------ | -------------------------- | ------------------------------------------ | ------------------------------------------------- | --------------------- | ------------------------ |
   | **Thorough** | full pass                            | 0 / 0 %                    | 0 / 0                                      | 0 / 0 / 0                                         | 0                     | 0 of 643                 |
   | **Standard** | stop after 87 % of the pass in order | 13 / 12 %                  | 0.0004 / -0.0005                           | 0.0003 / 0.0005 / 0.005                           | 0.004                 | 42 of 643                |
   | **Quick**    | stop after 60 % of the pass in order | 40 / 38 %                  | 0.0028 / 0.0079                            | 0.0009 / 0.0055 / 0.012                           | 0.007                 | 92 of 643                |

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
   - The data support a **"still moving" indicator**: the cell's recent step size against its noise, as M1 does. The
     10 % it flags most hold about 3x their share of the remaining improvement.
   - It is a hint, not a guarantee. Most cells that still improve are not flagged.
   - The direction measure (M2) is the better match to "edge work" on paper. It adds nothing over step size here,
     because edge repairs arrive as single commits.
   - I would not stop the Final settle by either measure.

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

| measure    | what it is |
| ---------- | ---------- |
| M1 `step`  | Size of the last step, relative to the footprint. |
| M2 `drift` | Per region: sqrt(max(0, sum over pairs i<j of d_i·d_j) / 3), divided by the region's norm. The cell takes the larger of core and edge. Wobble scores about 0 at any size. Steady growth or shrinkage scores its rate per checkpoint. |
| M2b `ucb`  | M2 with a 2-sd bound under random step-sign flips. It correlates 0.74 with M1. |

### Selected stop rules

Mean frames saved; mean loss [95 % t CI]; n = 18 real, 15 sims.

| rule                  | saved real / sims | real median cos         | real 10th-pct cos       | sims r                   | sims edge error          | sims bitten share     |
| --------------------- | ----------------- | ----------------------- | ----------------------- | ------------------------ | ------------------------ | --------------------- |
| M1 0.08, 80 % settled | 38 / 62 %         | 0.0025 [0.0015, 0.0035] | 0.0074 [0.0027, 0.0122] | 0.0023 [0.0015, 0.0032]  | 0.0107 [0.0059, 0.0154]  | 0.025 [0.014, 0.036]  |
| M2 0.02, 90 %         | 36 / 56 %         | 0.0022 [0.0016, 0.0029] | 0.0064 [0.0034, 0.0094] | 0.0019 [0.0013, 0.0026]  | 0.0088 [0.0049, 0.0128]  | 0.022 [0.011, 0.032]  |
| M2 0.03, 95 %         | 25 / 44 %         | 0.0014 [0.0008, 0.0019] | 0.0030 [0.0004, 0.0056] | 0.0011 [0.0005, 0.0017]  | 0.0049 [0.0017, 0.0081]  | 0.014 [0.006, 0.022]  |
| M2 0.01, 95 %         | 0 / 20 %          | 0 (never fires on real) | 0                       | 0.0002 [-0.0001, 0.0006] | 0.0021 [-0.0003, 0.0045] | 0.005 [-0.001, 0.011] |

- **Mixed, so ruled out.** The plan rule found that M1 0.08 / 80 % passes Quick, and M2 0.01 / 95 % passes Standard.
  M2 0.01 / 95 % saves nothing on real. Neither beats the fixed stop at the same frames.
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
  - The fixed-stop table, the per-arm table, the capture table, the zero-step activity check and the bite
    trajectories were added after the first scoring pass.
  - The real reference was corrected to exclude the run's own seed for every arm, as the plan says. The first pass
    pooled the same-seed Max for P-30 and S-30. That moved the numbers by at most 0.0003.
- **Not done:** what a 0.003 cosine loss does to the traces. Traces were not saved per checkpoint, so there is no
  cheap version.
