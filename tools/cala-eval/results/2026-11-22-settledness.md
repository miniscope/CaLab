# Per-cell settledness and Final-settle stop levels (22 Nov 2026)

Offline study on PR #464's saved runs; no new runs. The measures, stop grid, scoring and level rule were committed
before any quality number was computed: [plan](2026-11-22-settledness-plan.md), commit `82a13823`. Anything added
afterwards is marked **(after the runs)**.

- All generated tables: [2026-11-22-settledness-tables.md](2026-11-22-settledness-tables.md).
- Script: [`settledness.py`](../settledness.py) (`dist`, `score`); about 1 min, under 0.7 GB.

**Data.**

- Real: Samara `10_43_21` and `14_57_02`, arms Max / P-30 / S-30, seeds 1-3, so n = 18 runs. Seeds share a
  recording, so the intervals are too narrow.
- Sims: pairs 5, 6 and static 5, 6, 7, three arms each, so n = 15 runs with ground truth.
- Every run's in-order full Final settle was saved as a library every 1,200 frames.
- "Stopping at checkpoint c" means taking that library.

## Short answers for the PI

1. **Footprints in the library change in jumps, not continuously.**
   - A cell's footprint only changes when a refine is committed.
   - Between two checkpoints, about 45 % of cells do not change at all.
   - Over three checkpoints (3,600 frames), about a third of cells do not change at all.
   - So "late updates often change little" is literal: many late updates are no update. The rest are mostly
     wobble, small steps with no lasting direction.
2. **The proposed per-cell measure can tell wobble from directed edge work, but on real runs that does not predict
   which cells will still improve.**
   - **M2 "drift"** is the steady, same-direction part of a cell's last three steps, measured separately on the core
     and on an edge ring that includes empty pixels next to the footprint. On a planted test it does what the PI
     asked:
     - pure wobble scores 0;
     - a bite filling in scores 0.10, with a smaller step than the wobble;
     - a slowly growing edge scores 0.05.
   - On the runs, the cells it flags are barely the cells that still improve. The Spearman correlation with a cell's
     remaining gain is:
     - 0.11 against Max (real);
     - 0.01 against truth (sims), which is not distinguishable from zero.
   - **M1 "step"** (the size of the last change) does a little better: 0.17 real, 0.05 sims. That is still weak.
   - **Bites heal in one jump.**
     - Sims have 204 bitten neighbour pairs that heal during the pass.
     - At the checkpoint before each heal, the drift measure rated the bitten cell as calm as any cell: median
       percentile 0. The cell had no committed change in the window and then healed in a single commit.
     - No look-back measure sees that coming. M1 ranks those cells high (86th percentile) only because they wobble
       a lot.
3. **No stop rule beat simply stopping the in-order pass at a fixed point.**
   - All 14 pre-registered rules (2-3 measures x thresholds x settled shares of 80-95 %) were compared with a fixed
     stop that saves the same mean frames.
   - None did better on both real and sims. The paired differences are small:
     - median cosine within ±0.0006 (real);
     - footprint r within ±0.0007 and edge error within ±0.0024 (sims);
     - 10th-percentile cosine within ±0.0035 (real).
   - Of the 84 comparisons, the few significant ones mostly favour the fixed stop. For example, M1 at 0.08 / 80 % has
     +0.0007 footprint r loss on sims, CI 0.0003-0.0012.
   - The one exception is M2b at 0.08 / 90 %. It was better on sims edge error (-0.0024, CI -0.0047 to -0.0002) but
     worse on real 10th-percentile cosine (+0.0017, CI 0.0003-0.0031). Expect a few such results by chance.
4. **Why: in an in-order pass, stopping early means the end of the recording is never re-read.**
   - It does not matter which cells look settled. Cells born late in Discover lose the most: their footprint r loss
     is 5-10x the library's.
   - **(After the runs)** A purely structural predictor does a bit better on sims than either measure (Spearman 0.09
     against 0.01-0.05): the share of a cell's life that the settle has re-read so far. It is worse on real (0.05).
   - Per-cell remaining gains are small and mostly noise. No signal tested here predicts them well.
5. **Levels by the pre-registered rule, which falls back to fixed budgets because no rule beats them:**

| level        | Final settle                                             | frames saved     | real, vs Max: median / 10th-pct cosine loss | sims, vs truth: r / edge error / bitten share loss | late-born r loss (sims) | bites left unhealed (sims, of 708) |
| ------------ | -------------------------------------------------------- | ---------------- | ------------------------------------------- | -------------------------------------------------- | ----------------------- | ---------------------------------- |
| **Thorough** | full pass                                                | 0 %              | 0 / 0                                       | 0 / 0 / 0                                          | 0                       | 0                                  |
| **Standard** | stop at 90 % of the pass (in order)                      | 10 % (0 % sims*) | 0.0002 / -0.0009                            | 0 / 0 / 0*                                         | 0*                      | 0*                                 |
| **Quick**    | stop at 60 % of the pass (in order)                      | 40 % (37.5 % sims) | 0.0028 / 0.0076                           | 0.0009 / 0.0055 / 0.012                            | 0.007                   | 92                                 |

   \* Sims checkpoints come every 12.5 % of the pass, so "90 %" rounds up to the full pass there. The sims cannot
   show what the last 10 % is worth.

   - **Standard.** The plan's tolerances were real 0.001 / 0.003 / 1 point and sims 0.001 r / 0.005 edge / 0.01
     bitten. Stopping at 75 % misses Standard on real by 0.0001 (0.0011 median cosine).
   - **Quick.** The tolerances were 0.003 / 0.01 / 3 points and sims 0.003 / 0.015 / 0.03. Quick fails at 50 %:
     real median cosine 0.0032.
   - Quick leaves 13 % of the bites that the full pass would have healed (92 of 708), and late-born cells lose about
     8x the library average.
   - Recommendation: **ship Thorough as the default.** If the PI wants the options:
     - offer Quick as "about 40 % faster, slightly rougher edges and late cells";
     - Standard saves too little to be worth a level.
6. **Per-cell settledness for the UI:** I would not ship M1 or M2 as a "how settled" number yet. Neither tells the
   user which cells will still change. What would work is below.

## What would make a per-cell number useful (not tested here)

**Change the read order, not only the stop.** The saving can only be per cell if the settle reads the frames where
unsettled cells are active. That means need-driven or strided reading, like #462's look-back pool, instead of an
in-order sweep.

#464's spread budgets (B25-B75 read strided) already end within 0.002 of the full pass at three quarters of the
work. They saved only end libraries, so they could not be scored per checkpoint here.

**Next study:**

- Strided-order runs with checkpoint libraries.
- Score coverage-based settledness (the share of the cell's active frames re-read) against truth.
- Keep M2 as the edge-direction readout.

**Use the engine's own noise.**

- Per-cell split-half noise (`SlowLoop.footprintNoise`) was not saved per checkpoint, so both measures here use the
  footprint's own scale.
- The refine gate already compares every change with that noise. A cell whose gate refuses all changes over a
  window is settled by the engine's own test, and that is about a third of cells at any time.
- A "refused changes in a row" counter per cell is free online. It is the honest first version of a settled badge.
  It still would not predict heals.

## Details

### Measures (from the plan)

Footprints are scaled to unit L2 norm. The window is the last 4 checkpoints (3 steps). Regions:

- core = pixels at or above half the peak;
- edge = the window's union support dilated by 2 px, minus the core.

| measure     | what it is                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| M1 `step`   | size of the last step relative to the footprint (magnitude only)                                                  |
| M2 `drift`  | per region, sqrt(max(0, sum over pairs i<j of d_i·d_j) / 3) / region norm; the cell takes the larger of core and edge. Wobble scores about 0 at any size; steady growth or shrinkage scores its rate per checkpoint |
| M2b `ucb`   | M2 with a 2-sd bound under random step-sign flips. It correlates 0.74 with M1, so it mostly re-measures step size |

A cell counts as **settled** below the threshold. Cells new to the window count as **not settled**. The first
possible stop is checkpoint 3: 20 % of the pass on real, 37.5 % on sims.

### Stop rules (mean frames saved; mean loss with 95 % CI; full tables in the tables file)

| rule                  | saved real / sims | real median cos loss    | real 10th-pct cos loss | sims r loss             | sims edge-error loss    | sims bitten-share loss  |
| --------------------- | ----------------- | ----------------------- | ---------------------- | ----------------------- | ----------------------- | ----------------------- |
| M1 0.08, 80 % settled | 38 / 62 %         | 0.0025 [0.0015, 0.0035] | 0.0073 [0.0023, 0.0122] | 0.0023 [0.0015, 0.0032] | 0.0107 [0.0059, 0.0154] | 0.025 [0.014, 0.036]    |
| M2 0.02, 90 %         | 36 / 56 %         | 0.0022 [0.0016, 0.0028] | 0.0062 [0.0030, 0.0093] | 0.0019 [0.0013, 0.0026] | 0.0088 [0.0049, 0.0128] | 0.022 [0.011, 0.032]    |
| M2 0.03, 95 %         | 25 / 44 %         | 0.0014 [0.0008, 0.0020] | 0.0033 [0.0005, 0.0062] | 0.0011 [0.0005, 0.0017] | 0.0049 [0.0017, 0.0081] | 0.014 [0.006, 0.022]    |
| M2 0.01, 95 %         | 0 / 20 %          | 0 (never fires on real) | 0                      | 0.0002 [-0.0001, 0.0006] | 0.0021 [-0.0003, 0.0045] | 0.005 [-0.001, 0.011]   |

Each rule minus a fixed stop at the same mean frames, paired per run:

- every difference is within ±0.0007 in r and ±0.0024 in edge error (sims), and within ±0.0035 in 10th-percentile
  cosine (real);
- most CIs include 0;
- the significant ones mostly favour the fixed stop (see short answer 3).

M1 at 0.08 / 80 % passes the Quick tolerances at 50 % mean saved, but it is no better than fixed truncation, so by
the plan rule the fixed budget is preferred.

### Where the loss sits (sims)

- **Rules spread their loss unevenly.** For M1 and M2b, cells flagged unsettled at the stop carry 3-6x the edge-error
  loss of settled cells. M2 does not separate them this way (CIs overlap).
- **Late-born cells.** Born in the second half of Discover, they lose 0.009-0.017 in r at the stops that save a third or more
  of the pass, against 0.001-0.003 for the library.
- **Bites.** At the Quick-like stops, 11-24 % of the bites that heal by the end of the full pass are still bitten.

### Caveats

- The real reference (Max `B100`) is itself read in order and was still rising at the end of the pass (#464, Fable
  review). It favours the full pass.
- The sims use truth and do not have that bias. They agree in direction.
- Sims are 9,600 frames with 8 checkpoints, so their stop points are coarse.
- Thresholds were chosen from the measure distributions only. A different grid could fire at other points, but no
  rule beat fixed truncation, so tuning would at best match it.
- Not done: what a 0.003 cosine loss does to the traces. Traces were not saved per checkpoint, so there is no cheap
  version.
