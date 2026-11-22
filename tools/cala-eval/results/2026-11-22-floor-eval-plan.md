# PR H plan: the smart floor and the default speed (22 Nov 2026)

**Amendment 2 (before any run; parent, for budget): trimmed.** Only Samara `10_43_21` (`sa`: Max x3, then f10, see,
f14, f07 x2 each) and the two sims (`m5`, `t6`: Max x2, f10 x2). The workshop recording and `14_57_02` are dropped.
Order: `sa-max-1, m5-max-1, t6-max-1, sa-max-2, m5-max-2, t6-max-2, sa-max-3`; R1; then `sa` f10, f07, see, f14 (rep
1), `m5-f10-1, t6-f10-1`, `sa` f14, see, f07, f10 (rep 2), `m5-f10-2, t6-f10-2`. V1 runs on `sa`, `m5`, `t6`; V2 on
`sa`. Rules read "on at least 2 of the 3 recordings" now read on `sa` alone, with the sims (T1-T4) as the truth
anchor; with one real recording the recommendation is stated as provisional. Expected: about 2 h of Chrome, then
scoring. Everything below is otherwise unchanged.

Design: `~/Projects/cala-data/demix-bench/beta_speed_control_design.md`, section 2 (the floor), section 6 row H, and
the PI decisions (Q1: Max stays the default until this eval; this eval informs the recommended position).
This plan, its pass lines, the run script and the arm rule are committed and pushed **before any run**. The arm
speeds themselves come from the Max runs (rule R1) and go in a second commit before the first paced run.
Anything decided after a run is marked **(post hoc)** in the results.

## Framing (PI, 22 Nov)

- cala has no users yet. Quality is judged against truth on sims and, on real data, with proxies that do not assume
  any path is right: held-out reconstruction, residual structure around cells, neighbour trace cross-talk,
  repeatability.
- **No arm is the reference.** Max is one arm. "Matches Max" or "matches the old release" is never a criterion
  (memory note `cala-no-release-parity`).
- The PI expects slower runs to be slightly better, down to the floor. Tier 1 (`2026-11-22-slider-tier1.md`, with its
  corrections) found the final library close to Max at 30 and 60 fps, with 50-75 extra, mostly weak, cells per Samara
  recording. This eval tests the expectation with proxies, not with agreement to Max.

## Build and machine

- Branch `eval/cala-floor-default` from `main` `8a39a648` (Speed control #474, floor #468, governor/pool defaults
  #469, settle levels #471). No app code changes: only eval scripts and results.
- WASM built from this worktree; dev server from this worktree on port 5198 (never 5190/5195).
- Headed Chrome (Metal GPU), `memory-measure.mjs --single --headed --every 5 --lookback [--pacefps F]`, one run at a
  time, guarded by `while pgrep -f "^node .*memory-measure.mjs"`. The driver clears the stored speed
  (`cala.speed.v1`), so the URL's `pacefps` alone sets the target. With `--pacefps`, the app runs what the Speed
  control's Fixed position runs: governor on, cap 2, settle pool from the core count (18 cores: S = 1), Final settle
  Thorough (full pass). Each run's log is checked for `cap 2`, `settleWorkers 1` and a full settle; a run that
  differs is reported and not used.
- Load average at the start and end of every run in `load.txt`. Runs are scheduled by the parent agent so that no
  other agent's timed runs overlap. Fixed-library scoring (below) runs only after the Chrome batch, at most 2 at a time,
  never during timed runs.
- RAM: Chrome about 3 GB, scoring about 0.8 GB per process; under 6 GB.
- The Samara data is read only (`--single` makes no export; qc_eval reads `img/`).

## Recordings and arms

| tag | recording | frames | fps |
| --- | --- | ---: | ---: |
| `sa` | Samara `10_43_21` | 17,879 | 30 |
| `sb` | Samara `14_57_02` | 17,875 | 30 |
| `ws` | workshop `prerecorded/raw` | 23,711 | 20 |
| `m5` | sim `sims-v3/v3_motion_s5` (truth anchor) | 9,600 | 20 |
| `t6` | sim `sims-v3/v3_static_s6` (truth anchor) | 9,600 | 20 |

The sims (added at the parent's request, before any run) are the v3 recalibrated minisim recordings: 10 px cells at
the real recordings' edge blur, calibrated on the workshop recording (`2026-11-12-sim-v3-scales.md`). One with
motion, one static, different seeds. On the sims only `max` and `f10` run, 2 runs each.

| arm | target | runs per recording |
| --- | --- | ---: |
| `max` | no pacing (Max) | 3 |
| `see` | `seeAllFps` | 2 |
| `f14` | 1.4 x floor | 2 |
| `f10` | floor | 2 |
| `f07` | 0.7 x floor | 2 |

**R1, the arm speeds (fixed before any run).** For each recording, from its three Max runs:

- **F** = the median over the three runs of the **published** (ladder) floor at the last `?debug` reading before
  Discover's last frame. That is the mark a user sees after a Max run. 1.4 x and 0.7 x are applied to the same F,
  rounded to whole fps.
- **seeAllFps** = the median over the three runs of `sees every frame below N` at the same reading, as an integer.
- If `seeAllFps` is at or above 0.9 x the Max runs' median achieved fps, the `see` arm is dropped (it would behave as
  Max) and that is reported. If two arms land within 5 % of each other, both still run.
- Sims: F = the lower of the two Max runs' published floors (two runs have no median; low is the conservative side).
- The resulting numbers (`targets.txt`) are committed before the first paced run.

**Run order.** Phase A: the nine Max runs, interleaved `ws, sa, sb` x 3, then `m5-max-1, t6-max-1, m5-max-2,
t6-max-2`. Then R1. Phase B, in this order:

1. `ws-f10-1`; `sa` f10, f07, see, f14 (rep 1); `sb` f10, f07, see, f14 (rep 1);
2. `ws-f10-2`; `sa` f14, see, f07, f10 (rep 2); `sb` f14, see, f07, f10 (rep 2);
S. `m5-f10-1, t6-f10-1, m5-f10-2, t6-f10-2`;
3. `ws` f07, see, f14 (rep 1); `ws` f14, see, f07 (rep 2).

**Trim rule.** The parent asked for the full batch. If time forces a trim, the batch stops after block S: both
Samara recordings with every arm, the workshop with Max and floor only, and the sims. The results say so.
If the app cannot open a sim folder (no Chrome run on a minisim recording has been made before), the sim runs are
dropped and the results say so.

Expected Chrome time (design section 2's Discover times plus 90 s / 188 s Final settle, plus about 1 min per run of
start-up): phase A about 40 min plus 15 min of sim Max runs, blocks 1-2 about 2 h 10 min, block S about 30 min,
block 3 about 1 h 20 min. **About 5 h in all.** Fixed-library scoring follows the Chrome batch, 2 at a time.

## Readings and pass lines

All readings are per run, then per arm (mean of its runs), per recording. "Both runs" means each run of the arm on its
own.

### H1. Is every consumer served at the floor, and not at 1.4 x floor?

Per consumer, one number at Discover's last frame (`-probe.json` `atFramesDone`, `-work.json`):

| consumer | reading | served when |
| --- | --- | --- |
| Background settle | dose = (`csettle.fit` + `csettle.heldOut`) / `csettle.live` | dose >= 1.8 (90 % of cap 2) |
| Need-driven look-back | `lb.requested` per birth (`lb.births`) | >= 95 % of the same recording's `f07` mean |
| Slow loop (Discovery) | frames dropped for the slow loop, `drop / fwd` | <= 0.5 % |
| Visit workers | mean busy share over paced running samples | reported only (`visitsBind` question): idle if <= 0.85 |

Also reported: the share of paced running samples with the governor's limit `cap`; cells still in need at the last
frame; the slow worker's mean batch wait.

- **H1 passes** on a recording when both `f10` runs have every served consumer (the first three rows) served, and both
  `f14` runs have at least one not served.
- `max` and `see` are scored the same way, as more points on the curve.

### H2. Does 0.7 x floor add only idle time?

- **H2 passes** on a recording when, `f07` against `f10` (arm means): dose, need frames per birth and drop share each
  differ by at most 5 % (or 0.1 points of drop share), and no quality proxy (Q1-Q4) is better at `f07` beyond the
  noise margin (below). The extra Discover time is reported.

### H3. Floor estimate against measurement

- **Measured floor** = the fastest tested speed at which both runs are served (H1's rule), bracketed by the next faster
  tested speed (all five arms are points; `max` counts at its achieved fps).
- **Estimate error** = the estimate's position against that bracket, for:
  - the estimate a user sees after a Max run (F, unpaced);
  - the estimate a paced `f10` run shows at its last Discover reading (paced).
- **`unpacedFactor` check.** The slow-worker term as measured at Max (after the 0.75 factor) against the same term
  measured paced at `f10`. The factor holds if the two agree within 15 %; otherwise the factor that would make them
  agree is reported.
- **Priors.** The prior shown before measurement (20 or 30) is reported against the measured floor. It should be at
  or below it ("conservative means low").
- **Visits.** Whether visit workers have idle time at `f10` (the `visitsBind` decision, design section 2).
- Pass line for the estimate: the published estimate is within one ladder step of the measured bracket. Reported
  per recording.

### Quality: final libraries, proxies only

Each run's final library (`-final.json`, unfiltered values, as `JsTraceLibrary.footprintValues` gives them) is
converted to `footprints.bin` and scored with `qc_eval real <recording> --library footprints.bin --motion --batch 8
--fps <30|20> --slow-seed 1 --dump --no-signed` (`floor_eval_score.sh`): the app's preprocessing and motion are re-run,
the fixed library's traces are solved for every frame, and the held-out score, QC metrics and traces are written.

**Validation, before any proxy is read** (on one Max library per recording):

- **V1, alignment.** The same library shifted by 1 px (x) must score a lower Q1 and a lower median per-cell held-out z
  than unshifted. If V1 fails on a recording, Q1-Q4 are not read there; quality falls back to Q5 and the counts, and
  the results say so.
- **V2, split.** The app's held-out split is not reproduced exactly (it depends on the slow loop's frame count, which
  drops change), so the scored frames are partly frames the library was fitted on. Every arm's library was fitted on
  the whole recording by its full Final settle, so the effect is shared. V2 scores the same library with
  `--slow-seed 1` and `2`; the difference in Q1 is reported next to the arm differences.

**Proxies** (direction: better).

| | proxy | from | better |
| --- | --- | --- | --- |
| Q1 | held-out reconstruction: `S_frac` over the whole run, signal-weighted over the windows (`ho_score_frac` x `ho_signal`) | `global.tsv` | higher |
| Q2 | median per-cell held-out z (`ho_marginal_z`, last checkpoint) on the **common cells** | `ho_cells.tsv` / `final.tsv` | higher |
| Q3 | residual structure: `residual_excess` at the last checkpoint (mean over blocks of excess residual variance) | `global.tsv` | lower |
| Q4 | neighbour cross-talk: median absolute correlation of high-passed traces over common-cell pairs with centroids within 1.5 D (D = 10 px) | `dump_trace.f32` | lower |
| Q5 | repeatability: run-to-run median single-pair cosine of matched cells, and the matched share | the libraries | higher |

- **Common cells** (Q2, Q4): the cells of a run that have a one-to-one match (greedy by footprint cosine, centroids
  within 12 px, cosine >= 0.7) in every other run of the same recording, all arms. No run is the anchor. Paced arms
  add 50-75 weak cells (tier 1); those are reported apart: count, median held-out z, median peak z, footprint size.
- Also reported per run: cells, median footprint size (pixels > 0 and >= 10 % of peak), whole-library Q2.
- **Noise margin.** Per recording and proxy, the largest run-to-run difference within any arm (Max: over its three
  pairs). An arm difference counts only beyond that margin.
- **Trend.** Per recording and proxy, Spearman rho between the proxy and the run's Discover time, over all runs.

### Truth on the sims (`m5`, `t6`)

Each sim library is scored with `qc_eval sim <sim> --library footprints.bin --motion` (`t6`: `--gt-offset none`, the
static sim has no shift record and the app's registration of it is near identity), the same fixed-library scoring as
the real data, plus the ground-truth matching qc_eval does (footprint r >= 0.7, Hungarian, against detectable units).

| | truth reading | better |
| --- | --- | --- |
| T1 | precision (matched cells / cells) | higher |
| T2 | recall (matched detectable units / detectable units) | higher |
| T3 | median footprint r of the matched cells | higher |
| T4 | median trace r of the matched cells with their GT trace | higher |
| T5 | false cells (count) | lower |

- Noise margin: per sim and reading, the larger of the two within-arm run-to-run differences.
- Q1-Q5 are also computed on the sims, which shows whether the proxies move with the truth there.

### The recommendation (rule fixed now)

Total wall time per arm = Discover plus Final settle (in-page probe), from the first frame to the settled library.

- **D1, slower pays.** If `f10` is better than `max` beyond the margin on at least 2 of Q1-Q4 on at least 2 of the 3
  recordings, and worse beyond the margin on none of Q1-Q4 on any recording: recommend a paced default. Then, if
  `see`'s gain over `max` is at least two thirds of `f10`'s on those proxies (mean over recordings), recommend
  `seeAllFps` (cheaper); otherwise the floor. D1 also needs the sims: `f10` worse than `max` beyond the margin on
  none of T1-T4 on either sim. If a sim says worse, the reading is D3.
- **D2, slower does not pay in the final library.** If no proxy has `f10` better than `max` beyond the margin on at
  least 2 recordings: Max stays the default, and the floor is offered as a position.
- **D3, mixed.** Otherwise the results report the trade-off per proxy with its time cost, and recommend the fastest arm
  that is worse beyond the margin on no proxy, with the reason.
- Q5 and the cell counts inform the write-up but do not decide D1-D3 (repeatability can rise for the wrong reason, a
  cell set that stops changing).
- The live library (during the run) is not part of this decision; tier 1 covered it.

## Not in this plan

- Sims at `see`, `f14` and `f07` (only `max` and `f10` run there). The model (qc_eval's virtual clock) does not stand
  in for Chrome: it fails its calibration at Max and at 60 fps.
- Curves and Auto (PR J).

## Files

- `tools/cala-eval/floor_eval.sh` (Chrome runs), `floor_eval_score.sh` (fixed-library scoring),
  `floor_eval_summary.py` (`targets`, `fp`, then the tables).
- Run data `~/Projects/cala-data/runs/floor-eval/` (`load.txt`, `targets.txt`, per-run files, `score/<tag>/`).
- Results: `tools/cala-eval/results/2026-11-22-floor-eval.md`, plain-language summary for the PI first.
