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

## Round 2: precision demand (targets written 18 Nov 2026 before any result)

**Change.** `--lookback-target E` replaces the fixed K-frame window with a precision demand: every cell whose
split-half footprint noise (`SlowLoop::footprint_noise`, relative) is above E needs look-back frames, newborns and
their neighbours first, noisy settled cells after them, from the same shared block scheduler. A cell wants the blocks
before its birth first, then any other seen block it has not had from look-back; no block is served twice to a cell;
it stops at E (re-enters above 1.15 E); the cursor idles when no cell needs data. Held-out frames are read and
preprocessed but not solved and cost no budget (a third of the previous look-back frames were solved then dropped).

**Target E.** End-of-Refine median noise in `DR-main` is ~0.047 (static_s5 `convergence.tsv`), end of Discover ~0.09.
First arm E = 0.05; the calibration run (`cr-calib`, `DR-main` flags + `--noise-dump`) gives the per-cell
distribution after Refine; E is moved to that distribution's median if it differs materially. Noise vs r is checked on
the same run.

**Arms (quick tier, vs cached `cr-quick/DR-main`).** All: `--passes 1 --joint-update all --joint-sign all --lookback 2
--lookback-drain 4800 --lookback-target E`; `LBP-x2` (half-life 6000) and `LBP-x2-hl24k` (`--stats-half-life
24000`). The round-1 drain arms `LBD-x2` / `LBD-x2-hl24k` (K = 3000 window) are the reference for change 3.

**Targets (vs `DR-main`, paired, suite rules):**

1. Footprint r median, all / isolated / close-pair: not below `DR-main` (diff CI not below 0, or within noise with the
   point estimate >= `DR-main`). Near-match (PI relaxation, 18 Nov): each within 0.003.
2. Share r < 0.9 (all, isolated): within noise or better.
3. Trace corr excess < 1 D and bite shares: better than `DR-main`.
4. Total compute lower than `DR-main`: pass-loop wall (sum over sims) and the deterministic measure, look-back frames
   solved vs the 9600 frames x sims of the Refine pass (a look-back frame costs about a third of a Refine frame).
5. Settling: look-back frames per twentieth of the recording fall as births slow; cells still above E at the end
   reported (and whether the drain ended on the target or on its cap).
6. Matched: reported only (merge-rule loss, fix/cala-merge-close-pairs).

Full tier (with motion) only if the quick tier meets or near-matches 1-4.

## Round 2: results (19 Nov 2026)

Run tree `$CALA_DATA/demix-suite/cr-quick` (reports `report-DR-main-vs-{LBD-x2-lb9,LBP-x2,LBP-x2-hl24k}.md` and
`report-LBD-x2-lb9-vs-LBP-x2*.md`). `LBD-x2-lb9` is the round-1 drain arm (`--passes 1 --joint-update all --joint-sign
all --lookback 2 --lookback-drain 4800`) rerun on this branch's head binary: its footprints and traces are
byte-identical to the round-1 `LBD-x2` on all 5 sims (the round-2 change to held-out frames only applies with
`--lookback-target`), so every round-1 `LBD-x2` number stands for the PR binary.

**Answer.** The precision demand does not beat the K-window drain: `LBP-x2` and `LBP-x2-hl24k` are within noise of
`LBD-x2` on all 67 metrics but one, and cost more. **`LBD-x2` is the default arm.** Against `DR-main` it meets the
near-match bar: footprint groups all within 0.003, r < 0.9 shares within noise, crosstalk and bites much better,
and less compute.

| metric (vs `DR-main`, quick tier)                | DR-main | LBD-x2         | LBP-x2         | LBP-x2-hl24k   |
| ------------------------------------------------ | ------- | -------------- | -------------- | -------------- |
| Footprint r median, all (suite `fp_r`)           | 0.9892  | 0.9907 (+)     | 0.9908 (+)     | 0.9908 (+)     |
| Footprint r median, isolated (suite `fp_r`)      | 0.9927  | 0.9902 (−)     | 0.9900 (−)     | 0.9903 (~)     |
| Footprint r median, close-pair (suite `fp_r`)    | 0.9860  | 0.9905 (+)     | 0.9905 (+)     | 0.9907 (+)     |
| Footprint r < 0.9 share, all                     | 0.044   | 0.044 (~)      | 0.039 (~)      | 0.045 (~)      |
| Footprint r < 0.9 share, isolated                | 0.022   | 0.036 (~)      | 0.022 (~)      | 0.022 (~)      |
| Footprint r median, born in the first half       | 0.9904  | 0.9916 (+)     | 0.9917 (+)     | 0.9918 (+)     |
| Footprint r median, born in the second half      | 0.9585  | 0.9546 (~)     | 0.9661 (~)     | 0.9609 (~)     |
| Footprint r median, born in the last 20 %        | 0.9449  | 0.9375 (~)     | 0.9277 (~)     | 0.9393 (~)     |
| Footprint r < 0.9 share, born in the second half | 0.148   | 0.205 (~)      | 0.176 (~)      | n/a            |
| Trace corr excess < 1 D (headline)               | +0.142  | +0.071 (+)     | +0.065 (+)     | +0.072 (+)     |
| Bite share ratio < 0.5, 0.75-1.0 D               | 0.498   | 0.257 (+)      | 0.252 (+)      | 0.261 (+)      |
| Bite share < 0.5, later-born cell, 0.75-1.0 D    | 0.719   | 0.377 (+)      | n/a            | n/a            |
| leak_sd share > 0.1, < 1 D                       | 0.342   | 0.204 (+)      | n/a            | n/a            |
| Matched cells (mean per sim)                     | 349.0   | 342.6 (−)      | 339.6 (−)      | 342.0 (~)      |
| False cells                                      | 12.8    | 12.4 (~)       | 13.4 (~)       | 11.4 (~)       |
| Pass-loop wall, 5 sims (s)                       | 1721    | 1347           | 1585           | 1647           |
| of which look-back (s)                           | 0       | 515            | 748            | 801            |
| Look-back frames solved (vs 48000 Refine frames) | 0       | 118562 (2.47x) | 122225 (2.55x) | 126802 (2.64x) |

Birth-time rows are the "born in" rows above (second half and last 20 % rest on 3 static sims; the pairs sims have
few late births). Isolated diffs: `LBD-x2` −0.0025 [−0.0047, −0.0001], `LBP-x2` −0.0026 [−0.0041, −0.0004],
`LBP-x2-hl24k` −0.0024 [−0.0036, +0.0001]. `LBP-x2` vs `LBD-x2`: headline −0.006 [−0.023, +0.017], isolated −0.0001,
second half +0.0116 [−0.0029, +0.0224], all within noise.

**Compute.** A look-back frame solves the whole frame but skips the reservoir, ledger, QC and visits, about a third
of a Refine frame in qc_eval, so `LBD-x2`'s 118.6k look-back frames are ~40k Refine-frame equivalents against the
48k of the Refine pass, and the pass-loop wall is 22 % lower (1347 vs 1721 s; noisy, 4-6 runs shared the machine).
In the app the look-back could solve only the patch around the cells in need, so its cost would follow cell-frames.

### Two footprint scores

The suite's footprint r and `final.tsv`'s `best_r` differ in three ways: the suite (`demix_metrics.py`,
`pearson_matrix`) correlates the **unfiltered** footprint with the GT full footprint over the **whole frame**, matched
by Hungarian at r >= 0.7; `best_r` (`qc_eval` `write_library` -> `columns` -> `match_cells` -> `sparse_corr`)
correlates the **filtered** footprint with the GT passed through the same glow flattener, over the **union of the two
supports**, with its own match. Same matched cells (the suite's), pooled bootstrap CI:

| arm (vs `DR-main`)   | group             | suite `fp_r` (headline)    | `final.tsv` `best_r` (filtered) |
| -------------------- | ----------------- | -------------------------- | ------------------------------- |
| DR-main              | all / iso / close | 0.9892 / 0.9927 / 0.9860   | 0.9853 / 0.9894 / 0.9815        |
| LBD-x2               | all               | +0.0014 [+0.0006, +0.0025] | +0.0031 [+0.0021, +0.0040]      |
| LBD-x2               | isolated          | −0.0025 [−0.0047, −0.0001] | −0.0010 [−0.0031, +0.0009]      |
| LBD-x2               | close-pair        | +0.0044 [+0.0030, +0.0057] | +0.0061 [+0.0046, +0.0079]      |
| LBP-x2               | isolated          | −0.0026 [−0.0040, −0.0004] | −0.0009 [−0.0025, +0.0005]      |
| D-st2 (no look-back) | isolated          | −0.0046 [−0.0084, −0.0018] | −0.0026 [−0.0043, +0.0001]      |

On the filtered score the isolated gap is within noise. This is consistent with noise in the unfiltered tails
(look-back footprints are wider: median support 648 vs 616 px) but not proof, since the scores also differ in the
correlation domain and the match. The suite's headline metric is unchanged.

### Does the work settle?

Look-back frames and cell-frames per tenth of the recording, summed over the 5 sims ("drain" = after the last
Discover frame):

| tenth | LBD-x2 frames | LBD-x2 cell-frames | per frame | LBP-x2 frames | LBP-x2 cell-frames | per frame |
| ----- | ------------- | ------------------ | --------- | ------------- | ------------------ | --------- |
| 0     | 7885          | 404417             | 51        | 7790          | 454186             | 58        |
| 1     | 9600          | 974714             | 102       | 9600          | 967725             | 101       |
| 2     | 9600          | 1221689            | 127       | 9600          | 1106267            | 115       |
| 3     | 9600          | 1217819            | 127       | 9600          | 1123549            | 117       |
| 4     | 9600          | 951486             | 99        | 9600          | 1133481            | 118       |
| 5     | 9600          | 682701             | 71        | 9600          | 1080800            | 113       |
| 6     | 9600          | 517565             | 54        | 9600          | 1042436            | 109       |
| 7     | 9600          | 425820             | 44        | 9600          | 982914             | 102       |
| 8     | 9600          | 356244             | 37        | 9600          | 970906             | 101       |
| 9     | 9600          | 319813             | 33        | 9600          | 920618             | 96        |
| drain | 24277         | 408367             | 17        | 28035         | 399007             | 14        |

- **`LBD-x2` settles in cell-frames.** The frame budget is used throughout (an 8-minute sim never stops finding
  cells), but the cell-frames it serves fall 4x from the 3rd-4th tenth to the last, following births; the drain
  ends on its own with no cell in need on every sim (1930-2757 steps, cap 4800).
- **`LBP-x2` does not settle.** Cell-frames stay flat (~1.0-1.1M per tenth). At the end 61-70 % of cells are still
  above E = 0.05 on every sim (static_s5 363 / 507, static_s6 355 / 536, static_s7 330 / 516, pairs 63 / 103 and
  61 / 103). The drain ends before its cap not because cells reached the target but because their pools are empty:
  no block is served twice to a cell, and with 6000-frame forgetting the noise estimate never drops below E with
  the frames a cell can still get. The 24000-frame half-life (`LBP-x2-hl24k`) does not change this (356 / 508 above
  E on static_s5). E = 0.05 is the end-of-Refine median in `DR-main`, so half of the cells are above it there too;
  a precision demand needs a target the forgetting allows, or a noise measure that is not limited by it.

### Other checks

- **Flag off:** `qc_eval` at this branch's head with no look-back flags is byte-identical to main `7155c62`
  (`footprints*.bin`, `dump_trace.f32`, `final*.tsv`) on static_s5 and pairs_s5 (`cr-smoke/DR-lb9-off`).
- **motion_s5** (`cr-motion`, one sim, `LBD-x2` vs `DR-main`): headline +0.174 -> +0.107 (better), bites 0.75-1 D
  0.519 -> 0.311 (better), leak share 0.382 -> 0.272 (better); footprint r all +0.0019, isolated −0.0016 (both within
  noise), close-pair +0.0041 (better); filtered `best_r` all 0.9830 -> 0.9854, isolated 0.9907 -> 0.9894. No metric
  worse. Matched −16 and false −9 (net −7): a larger matched loss than the quick tier's −6.4, same merge-rule cause
  as far as we can tell (fix on `fix/cala-merge-close-pairs`). Pass-loop wall about equal (509 vs 498 s).
- **Full tier:** not run.

### Targets, plainly

1. Footprints within 0.003 of `DR-main`: **met** (all +0.0014, isolated −0.0025, close-pair +0.0044). Isolated is
   the one group below `DR-main` on the suite score; the PI accepts a small isolated gap.
2. Share r < 0.9: **met** (within noise in all groups; second-half +0.057, within noise).
3. Crosstalk and bites better: **met** (headline halved, bites about half).
4. Less compute: **met** (−22 % pass-loop wall, ~40k vs 48k Refine-frame equivalents).
5. Settling: **met for `LBD-x2`** (cell-frames fall with births; drain ends on need); **not met for the precision
   demand**.
6. Matched: −6.4 per sim (quick), −16 (motion_s5): the merge-rule loss also seen in `D-st2` and `DR-st2`.
