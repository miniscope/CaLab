# Concurrent Refine: look-back cursor inside Discover (prototype)

Targets written 18 Nov 2026 before any result (commit order shows it). Results below the targets.

## Question

Can a look-back cursor that runs during Discover, re-reading frames already seen from the saved
recording and feeding them through the existing Refine machinery (per-cell running statistics, the
cluster stores, refine visits) with the _current_ footprints, replace the separate Refine pass?

## Arms (same sims, same binary)

- `DR-main`: main Discover + 1 Refine (`--passes 2 --later-passes refine`, the suite default).
- `DR-st2`: Discover + 1 Refine with the Stage 2 replay (`--joint-update all --joint-sign all`).
- `D-st2`: Discover only with the Stage 2 replay (`--passes 1 --joint-update all --joint-sign all`).
- `LB-x{0.5,1,2}`: Discover only + look-back at 0.5, 1, 2 look-back frames per Discover frame, with the
  replay (`--passes 1 --joint-update all --joint-sign all --lookback R`); `LB-norep-x1` without the replay.

## Targets (LB at the chosen budget vs the references)

1. Footprint r with GT, median: all, isolated, close-pair, and share r < 0.9 (all, isolated): at least
   `DR-main` (diff CI not below 0, or within noise with the point estimate >= `DR-main`).
2. Trace corr excess < 1 D (headline) and bite share ratio < 0.5 per bin: no worse than `D-st2`.
3. Matched and false cells: within noise of `DR-main`. If the only gap is the matched loss that `D-st2`
   already shows (merge rule, branch fix/cala-merge-close-pairs), say so and do not count it against LB.
4. Compute: total slow + look-back + fast work of `LB` vs `DR-main` (wall seconds of the pass loop and
   the look-back's own wall), and the fast loop per-frame cost unchanged (the look-back uses its own
   preprocessor copy and trace engine, never the live one).
5. By birth time: footprint r of early-born (first 50 %) vs later-born (last 50 %) and late-born (last
   20 %) cells. Late-born cells are the key test: LB should close most of the gap between `D-st2` and
   `DR-main` for them. An honest expectation: a cell born at 90 % gets at most R x 960 look-back frames
   before the recording ends, against Refine's 9600, so a residual gap is likely there.

Tiers: smoke (crash/sanity, flag checks), motion_s5 alone (motion path), quick (decision), full if the
quick tier meets or nearly meets the targets.

## What was built (branch feat/cala-concurrent-refine, off by default, flag-off byte-identical to main)

- `SlowLoop::observe_lookback(frame, lib, traces, slow_index, only)`: a past frame, solved with the current library
  by a separate trace engine, goes into the running footprint statistics and the cluster stores of the cells in
  `only` (all cells when `None`). Nothing else sees it: no frame clock, ledger, probes, reservoir or noise
  correlation, so probation, cooldowns, commits and the held-out split are those of Discover alone. A frame held out
  in Discover stays held out. A targeted look-back frame does not advance the forgetting clock (it would age every
  other cell's statistics). `SlowLoop::mark_all_due` lets a driver force visits without new frames.
- `qc_eval --lookback R` (need-driven, the design): a cell born at frame `b` (new id in the published library; merge
  and split results are new ids) and every cell whose support touches it need frames `b - K..b`
  (`--lookback-frames K`, default 3000). The cursor re-reads 64-frame blocks from the recording (own copy of the live
  preprocessor; motion runs warp by the stored records), takes the block the most cells still need and serves it to
  all of them; `R` frames per Discover frame; idle budget is not banked. `--lookback-order newest` serves the newest
  cell first instead. `--lookback-drain N` (recorded data) keeps serving the cells in need after the last Discover
  frame, with Refine-scope visits, for at most N steps. `lookback.tsv`: frames, cell-frames, births, cells still in
  need, wall, and the work per tenth of the recording.
- `qc_eval --catchup X` (the PI's reference): every X Discover frames all cells get frames 0..t at once.
- `demix_metrics.py`/`demix_report.py`: footprint r by birth time (first half, second half, last 20 %).

## Results, quick tier (static s5-s7, pairs s5-s6; 18 Nov 2026)

Run tree `$CALA_DATA/demix-suite/cr-quick` (pairwise reports `report-DR-main-vs-*.md`). Every flag is vs `DR-main`
(paired, suite rules): (+) better, (−) worse, (~) within noise. All candidate arms use the Stage 2 replay
(`--joint-update all --joint-sign all`) except `LB-norep-x1`. `CU-2400` = catch-up at 2400, 4800, 7200.

| metric                                                    | DR-main | DR-st2     | D-st2      | CU-2400    | LB-x0.5    | LB-x1      | LB-x2      | LB-norep-x1 | LB-new-x1  |
| --------------------------------------------------------- | ------- | ---------- | ---------- | ---------- | ---------- | ---------- | ---------- | ----------- | ---------- |
| Footprint r with GT, median, all matched cells            | 0.9892  | 0.9931 (+) | 0.9864 (−) | 0.9910 (+) | 0.9890 (~) | 0.9897 (~) | 0.9903 (+) | 0.9849 (−)  | 0.9869 (~) |
| Footprint r with GT < 0.9, share, all matched cells       | 0.044   | 0.030 (~)  | 0.090 (−)  | 0.062 (−)  | 0.066 (−)  | 0.060 (~)  | 0.059 (~)  | 0.067 (−)   | 0.093 (−)  |
| Footprint r with GT, median, isolated                     | 0.9927  | 0.9928 (~) | 0.9881 (−) | 0.9920 (~) | 0.9880 (−) | 0.9892 (−) | 0.9901 (−) | 0.9885 (−)  | 0.9879 (−) |
| Footprint r with GT < 0.9, share, isolated                | 0.022   | 0.022 (~)  | 0.066 (~)  | 0.029 (~)  | 0.058 (~)  | 0.043 (~)  | 0.043 (~)  | 0.029 (~)   | 0.044 (~)  |
| Footprint r with GT, median, close-pair                   | 0.9860  | 0.9933 (+) | 0.9853 (~) | 0.9894 (+) | 0.9882 (+) | 0.9893 (+) | 0.9901 (+) | 0.9810 (−)  | 0.9855 (~) |
| Footprint r with GT, median, born in the first half       | 0.9904  | 0.9936 (+) | 0.9884 (−) | 0.9921 (+) | 0.9905 (~) | 0.9907 (~) | 0.9914 (+) | 0.9861 (−)  | 0.9885 (~) |
| Footprint r with GT, median, born in the second half      | 0.9585  | 0.9813 (+) | 0.8960 (−) | 0.9203 (−) | 0.9124 (−) | 0.9318 (−) | 0.9373 (−) | 0.9316 (−)  | 0.8917 (−) |
| Footprint r with GT, median, born in the last 20          | 0.9449  | 0.9775 (+) | 0.8397 (−) | 0.8422 (−) | 0.8261 (−) | 0.8484 (−) | 0.8546 (−) | 0.8175 (−)  | 0.8070 (−) |
| Footprint r with GT < 0.9, share, born in the second half | 0.148   | 0.087 (~)  | 0.534 (−)  | 0.420 (−)  | 0.447 (−)  | 0.396 (−)  | 0.349 (−)  | 0.359 (−)   | 0.534 (−)  |
| Trace r with GT, median, all matched cells                | 0.9716  | 0.9755 (+) | 0.9731 (~) | 0.9736 (~) | 0.9728 (~) | 0.9728 (~) | 0.9727 (~) | 0.9695 (~)  | 0.9726 (~) |
| Trace corr excess < 1 D                                   | +0.142  | +0.055 (+) | +0.104 (+) | +0.093 (+) | +0.086 (+) | +0.083 (+) | +0.077 (+) | +0.138 (~)  | +0.103 (+) |
| Bite share ratio < 0.5, 0.0-0.5 D                         | 0.378   | 0.084 (+)  | 0.336 (~)  | 0.316 (~)  | 0.284 (+)  | 0.250 (+)  | 0.296 (+)  | 0.440 (~)   | 0.339 (~)  |
| Bite share ratio < 0.5, 0.5-0.75 D                        | 0.352   | 0.086 (+)  | 0.297 (~)  | 0.240 (+)  | 0.247 (+)  | 0.197 (+)  | 0.194 (+)  | 0.442 (−)   | 0.299 (~)  |
| Bite share ratio < 0.5, 0.75-1.0 D                        | 0.498   | 0.160 (+)  | 0.437 (~)  | 0.335 (+)  | 0.371 (+)  | 0.313 (+)  | 0.292 (+)  | 0.604 (−)   | 0.417 (+)  |
| Bite share ratio < 0.5, later-born cell, 0.75-1.0 D       | 0.719   | 0.181 (+)  | 0.581 (+)  | 0.490 (+)  | 0.516 (+)  | 0.435 (+)  | 0.430 (+)  | 0.895 (−)   | 0.524 (+)  |
| leak_sd share > 0.1, < 1 D                                | 0.342   | 0.167 (+)  | 0.262 (+)  | 0.280 (+)  | 0.265 (+)  | 0.228 (+)  | 0.220 (+)  | 0.362 (~)   | 0.278 (+)  |
| Matched cells                                             | 349.0   | 341.6 (−)  | 337.8 (−)  | 339.2 (−)  | 340.4 (−)  | 339.2 (−)  | 341.2 (−)  | 345.2 (~)   | 340.4 (−)  |
| False cells                                               | 12.8    | 10.8 (~)   | 14.6 (~)   | 15.2 (~)   | 16.6 (~)   | 12.8 (~)   | 13.8 (~)   | 15.2 (~)    | 18.2 (~)   |
| Net (matched - false)                                     | 336.2   | 330.8 (~)  | 323.2 (~)  | 324.0 (−)  | 323.8 (~)  | 326.4 (−)  | 327.4 (−)  | 330.0 (~)   | 322.2 (~)  |
| Final cells matching 2+ GT units                          | 125.4   | 144.6 (−)  | 121.0 (~)  | 125.8 (~)  | 127.6 (~)  | 129.0 (~)  | 128.0 (~)  | 114.2 (~)   | 124.0 (~)  |
| Median support area                                       | 616     | 697        | 598 (~)    | 660        | 625        | 645        | 643        | 571         | 597 (~)    |

| arm         | pass-loop wall s (sum over sims) | of which look-back s | look-back frames | sims |
| ----------- | -------------------------------- | -------------------- | ---------------- | ---- |
| DR-main     | 1721                             | 0                    | 0                | 5    |
| DR-st2      | 1710                             | 0                    | 0                | 5    |
| D-st2       | 1066                             | 0                    | 0                | 5    |
| CU-2400     | 1444                             | 388                  | 72000            | 5    |
| LB-x0.5     | 912                              | 93                   | 23620            | 5    |
| LB-x1       | 1180                             | 207                  | 47240            | 5    |
| LB-x2       | 1198                             | 340                  | 94285            | 5    |
| LB-norep-x1 | 962                              | 164                  | 47240            | 5    |
| LB-new-x1   | 989                              | 154                  | 47240            | 5    |

Wall seconds are the sum over the 5 sims of `passes.tsv` wall (qc_eval pass loop incl. GT scoring, 6 runs at once, so
noisy); the look-back column is the look-back's own wall inside it. The fast loop is untouched by construction (the
look-back has its own preprocessor copy and trace engine; QC ms/frame within noise in every arm).

### Reading

1. **Crosstalk and bites: met.** Every look-back arm beats Discover-only replay (`D-st2`) on the headline (+0.104 ->
   +0.083 at 1x, +0.077 at 2x) and on bite shares; the replay is what does it (`LB-norep-x1` +0.138). Still short of
   `DR-st2` (+0.055), which is the best arm overall.
2. **Footprints of cells born in the first half: met.** 0.9907 (1x) / 0.9914 (2x) vs 0.9904 `DR-main`.
3. **Isolated cells: not met.** 0.9892 (1x) / 0.9901 (2x) vs 0.9927; up from `D-st2` 0.9881 but below. The
   catch-up arm reaches 0.9920: isolated cells, mostly born early, need _more frames with the final neighbours_, which
   need-driven look-back never gives a cell that is not new or next to a new one.
4. **Cells born late: not met, the main gap.** Second half 0.932-0.937 vs 0.959 (`DR-main`) and 0.981 (`DR-st2`);
   last 20 %: 0.85 vs 0.94 / 0.98, share r < 0.9 still 0.35-0.40 vs 0.15. Look-back lifts them from `D-st2` (0.896 /
   0.840) but not close. Many late "births" are merge/split results (new ids) of cells found early; in `DR-main` the
   Refine pass gives every one of them 9600 frames with the final library and a full pass of visits, while here a cell
   born at 90 % gets at most K frames before birth plus 960 after, and few visits to apply them.
5. **The budget saturates in these sims.** At every R the cursor is busy all recording (look-back frames per tenth
   constant) and 200-340 cells per static sim are still in need at the end; cell-frames per look-back frame fall from
   ~250 (2nd-4th tenth) to ~75 (last tenth) on static_s5 as births slow. Discovery never stops in an 8-minute sim, so
   these numbers cannot show the work falling to zero; the design makes it proportional to births (see below).
6. **Order:** serving the block most cells need beats newest-first (`LB-new-x1`: later-born worse, 0.892 / 0.807),
   because shared blocks serve many cells per re-read.
7. **Matched −8 to −10** in every replay arm including `DR-st2` and `D-st2`: the merge-rule issue
   (fix/cala-merge-close-pairs), not the look-back (`LB-norep-x1` −3.8, within noise).

### Compute

Pass-loop wall over the 5 sims: `DR-main` 1721 s, `D-st2` 1066 s, `LB-x1` 1180 s (look-back 207 s, 47k frames),
`LB-x2` 1198 s (340 s, 94k frames), `CU-2400` 1444 s (388 s, 72k frames). A look-back frame costs about a third of a
Discover frame in qc_eval (it skips reservoir, ledger, QC and visits but solves the whole frame); in the app it could
solve only the patch around the cells in need, so its cost would scale with cell-frames, not frames.

### Drain after Discover (recorded data)

`--lookback-drain 4800`: after the last Discover frame the look-back keeps serving the cells in need, with
Refine-scope visits, until nothing is needed or 4800 steps. Arms `LBD-new-x1/x2` (newest-first order; the shared-order
drain arms `LBD-x2` and `LBD-x2-hl24k`, stats half-life 24000, were still running when this was written; same tree).

| metric                                 | DR-main | LBD-new-x1 | LBD-new-x2 |
| -------------------------------------- | ------- | ---------- | ---------- |
| Footprint r median, all                | 0.9892  | 0.9878 (~) | 0.9892 (~) |
| Footprint r < 0.9 share, all           | 0.044   | 0.055 (~)  | 0.050 (~)  |
| Footprint r median, isolated           | 0.9927  | 0.9883 (−) | 0.9891 (−) |
| Footprint r median, born first half    | 0.9904  | 0.9892 (~) | 0.9906 (~) |
| Footprint r median, born second half   | 0.9585  | 0.9531 (~) | 0.9523 (~) |
| Footprint r median, born last 20 %     | 0.9449  | 0.9435 (~) | 0.9410 (~) |
| Footprint r < 0.9 share, second half   | 0.148   | 0.201 (~)  | 0.230 (~)  |
| Trace corr excess < 1 D                | +0.142  | +0.093 (+) | +0.084 (+) |
| Bite share < 0.5, later-born, 0.75-1 D | 0.719   | 0.460 (+)  | 0.432 (+)  |
| Matched                                | 349.0   | 343.0 (−)  | 341.0 (~)  |
| Pass-loop wall, 5 sims (s)             | 1721    | 1282       | 1510       |
| of which look-back (s) / frames        | 0 / 0   | 431 / 71k  | 658 / 136k |

The drain closes the late-born gap (second half and last 20 % within noise of `DR-main`) at less wall than Discover +
Refine, because it only re-reads what the cells in need lack (3000-9500 frames per sim at 2x, ending early on the pairs
sims). Isolated cells remain the one footprint gap (−0.004 median), for the reason in point 3 above.

**Revised answer.** For recorded data, Discover + look-back + drain matches Discover + 1 Refine on every footprint
group except isolated cells, with much better crosstalk and bites and ~12-25 % less compute; it does not reach
Discover + Refine with the replay (`DR-st2`). Adding an uncertainty-driven demand for all cells (point above) is the
next step and the likely fix for isolated cells.

## Can this replace the separate Refine step?

Not yet. For streaming it is a clear improvement over Discover alone at ~10-30 % extra compute (crosstalk, bites,
close-pair and early-cell footprints at or above `DR-main`), but late-born cells and isolated cells stay below
Discover + Refine, and far below Discover + Refine with the replay (`DR-st2`), which remains the quality reference for
recorded data.

## Notes for the design

- **Long recordings (days-weeks).** Work = (births x K) cell-frames, shared per re-read block, so it follows the
  birth rate and is bounded per cell; converged cells get none. On a long recording the cursor would idle once
  discovery slows (idle budget is not banked). The per-cell bound K should become a precision target (stop a cell when
  its split-half footprint noise, `footprint_noise`, is below a set level), which the statistics already provide.
- **Isolated and early cells** need a second, low-priority demand: cells whose footprint noise is above target get
  frames too (the same block scheduler), not only new cells and their neighbours.
- **Stats half-life.** Footprints are physically stable over days (PI, 18 Nov); recency weighting exists mainly
  because old frames' residuals used old neighbour footprints, and look-back re-solves old frames with the current
  ones. So with look-back on, the half-life can be lengthened; arm `LBD-x2-hl24k` tests 24000 frames.
- **What the app needs:** a worker that re-reads the saved raw file by frame range (random access), a copy of the
  preprocessing state (`Preprocessor::state()`/`from_state`) and the stored motion records, its own trace engine on the
  current library, and a `observe_lookback` call into the slow loop's owner (the stats and cluster stores live there).
  The block scheduler is a few hundred lines on the owner side; frames could be solved on a patch only.
