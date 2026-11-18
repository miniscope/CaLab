# Cluster replay, Stage 2 (Refine only, flag off by default)

18 Nov 2026. Branch `feat/cala-replay-stage2`, stacked on `feat/cala-cluster-replay` (#422, Stage 1). Design:
`~/Projects/cala-data/demix-bench/design_joint_update.md` (§2.4, §5 Stage 2; a "Stage 2 results" section there
summarises this file).

## Go / no-go, written down before any Stage 2 result

Full tier (14 sims: static s5-s9, motion s5-s9, pairs s5-s8), `--passes 2 --later-passes refine`, candidate adds
`--joint-update refine`. Baselines: main (flag off) and Stage 1 (#422 HEAD, `--joint-update refine`), both from
the Stage 1 suite run `demix-suite/full-signall` (`off`, `signall`; the binaries' flag-off output is identical to
main).

| # | metric | target | Stage 1 |
| - | ------ | ------ | ------- |
| 1 | Bite share (ratio < 0.5), 0.5-0.75 D | ≤ 0.25 | 0.203 |
| 2 | Bite share, 0.75-1 D | **≤ 0.25** | 0.338 |
| 3 | Trace corr excess < 1 D (headline) | ≤ Stage 1 (+0.106), seeds agree | +0.106 |
| 4 | Corr excess 0.5-0.75 / 0.75-1 D | ≤ +0.10 / ≤ +0.05 (design) | static +0.102 / +0.060 |
| 5 | Over-fill (est/true at c_j > 1.3, pairs < 1 D) | **≤ 5 %**, and next to undetected GT units no worse than main | 6.7 % (main 5.9 %) |
| 6 | Matched / false cells | within noise of main (CI covers 0 or better; at most -1 % matched, +1 false per sim) | +1.1 / -1.1 |
| 7 | Merges, splits | unchanged (Refine makes none) | unchanged |
| 8 | Slow-loop cost, Refine pass (observe + step, wall ms/frame, solo runs static s5 and motion s5) | **≤ +10 % vs main** | observe +30 % |
| 9 | Cluster stores, peak MB | reported (design 10-12 MB) | 38-43 MB |
| 10 | Final cells matching 2+ GT units | reported; split by est/true at c_j ≤ 1.3 (light regained) vs > 1.3 (absorption) | +17.9 |

| 11 | Footprint r with GT, median, isolated matched cells (no GT unit within 1.5 D) | **no regression**: paired change ≥ −0.005 with the CI's upper end ≥ 0 (and seeds not agreeing on a loss) | (new metric) |
| 12 | Trace r with GT, median, isolated matched cells | **no regression**, same rule as #11 | (new metric) |
| 13 | Footprint r / trace r / share footprint r < 0.9, for all / isolated / close-pair (< 1 D) matched cells | reported; close-pair footprint r expected to rise | (new metric) |
| 14 | Refine recovery: `demix_stages.py` Discover vs + 1 / 2 / 3 Refine passes, main vs Stage 1 vs Stage 2, quick tier | reported: share of main's Refine gain (Discover → +1 Refine) on footprint r (all / isolated / close) that each arm keeps, and the bite share / corr excess per stage | — |

Added before any Stage 2 run, after the probe (PI, 18 Nov): Refine's purpose is overall footprint accuracy from
more frames, not bites only; #11-#12 gate, #13-#14 are reported. The end goal is multi-pass-Refine quality at lower
cost, including during streaming Discover, so the Discover-only readout below is part of the report.

Flag off: `footprints.bin`, `footprints_pass1.bin` and `final.tsv` byte-identical to main.

Secondary readout (not gated here): pass 1 only (`--passes 1`), main vs `--joint-update all`, quick tier
(Discover-only: same rows as above, and the share of main's Discover → +1 Refine gain that a Discover-only run
with the replay reaches).

The slow-loop cost metric is new: qc_eval writes `slow_cost.tsv` per pass (wall ms/frame of `SlowLoop::observe` and
of `step`, and the loop's own deterministic work units per frame); `demix_metrics.py` copies the last pass into
`demix_det.json` and `demix_report.py` reports it next to QC ms/frame (which times the QC monitor, not the slow loop).
Timings from suite runs (2 at a time) are indicative; the gated number (#8) comes from solo runs.

## Probe: where the replay's fix is lost (static s5, diagnostics build)

`CALA_REPLAY_STAGES` dumps, analysed with `replay_stages.py` and the per-member solo gate counterfactual
(`~/Projects/cala-data/runs/replay2/{probe_s1, probe_it10, probe2_s1}`; fixed set = 168 bitten / 112 healthy GT
pairs at 0.5-1 D in main).

- The finish path (smoothing, significance, single-peak basin, inversion, `from_canvas`) is not where the fix is
  lost: < 5 % of bitten pairs lose their light there.
- With 1 alternation per visit the raw replay estimate on bitten pairs stays low (median i at c_j 0.038 vs 0.135 on
  healthy pairs); with 10 it heals (0.116) but the gate rejects it (first loss "gate" 52 %).
- Store age does not drive rejection: rejected share 0.74 with 200-500 stored frames, 0.67 above 2000.
  Restarts (136 per Refine pass on static s5) are not the Refine lever; they matter for Discover.
- The gate sees no rotation: the joint held-out gain equals the sum of the members' solo gains (median difference
  0.00, p90 +11.9). In 66 % of rejected proposals every proposed member loses on its own; 998 of 1725 accepted
  proposals carried a member that lost on its own.
- The `Cluster` excess test is overconfident: the replay's split halves are fitted in one basis estimated from all
  stored frames, so `h_A − h_B` misses the basis's noise. Members of all-healthy clusters (new column = current one
  at c_j) still passed it in most replays. Toy: `a_member_at_the_truth_is_not_proposed`.
- The sign rule is not the main cause: the plain and `Own` fits reject about 60 % of proposals too (`All` 69 %).

## What changed (Stage 2)

1. **Stores move instead of restarting** (`ClusterStore::move_to`). When a member's statistics disk leaves the
   store's pixels, the store is re-expressed on the members' current disks: pixels in both sets keep their sums and
   stored light; a new pixel starts at the current model (sums and every stored frame's light there are what the
   current columns predict from the frame's least-squares traces, the store analogue of `FpStats::seed_new`). It is
   linear in the stored coordinates, so it is one `ClusterHistory::reexpress` and works for an SVD backing too.
   Static s5: 0 restarts, 154-207 moves per Refine pass. Toy:
   `a_moved_store_keeps_its_history_and_starts_new_pixels_at_the_model`.
2. **Tighter pixel sets.** With moves cheap the store's pixels are the members' statistics disks (which already carry
   the statistics margin); the second margin is gone. Peak store memory 38 → 27 MB (static s5 33-35 MB).
3. **Knobs, default off** (measured and not adopted):
   - `JointAdmit::Member`: each member proposed on its own excess, with the split-half noise taken from the joint
     fit's standard errors. Static s5 + pairs s5: accepted proposals 1725 → 917, bite share 0.75-1 D 0.335 → 0.456,
     close-pair footprint r 0.9901 → 0.9877. A bitten member heals by small accepted steps, each below its own
     split-half noise; the honest test stops them. The held-out gate already protects the library, so the
     overconfident admission costs work, not accuracy.
   - `joint_carry`: the store re-solves traces with its own last estimate (one alternation per visit, carried).
     Same sims: bite share 0.75-1 D 0.233 → 0.168, corr excess +0.078 → +0.055, but over-fill (est/true > 1.3,
     pairs < 1 D) 0.075 → 0.112 and false cells +1 per sim, as more alternations did in Stage 1.
   - Sign rule in unfiltered space: not built; the probe showed the sign rule is not what the gate rejects.
   - Membership change (Discover births / deaths) still restarts the store: without stored leftover-light
     directions (design_discover_lookback.md §3.1a) the design's own fallback is to drop pre-birth history.

## Full tier (14 sims), Stage 2 = `qc_eval-st2-c --joint-update refine --joint-sign all`

Reports: `~/Projects/cala-data/demix-suite/full-stage2/report-vs-{main,stage1}.md`. Pooled, bootstrap 95 % CI,
"seeds" = sims agreeing in sign.

| # | metric | main | Stage 1 | Stage 2 | Stage 2 − Stage 1 [CI], seeds | target |
| - | ------ | ---- | ------- | ------- | --------------- | ------ |
| 1 | Bite share 0.5-0.75 D | 0.353 | 0.203 | **0.123** | −0.080 [−0.105, −0.056], 13/14 | ≤ 0.25 met |
| 2 | Bite share 0.75-1 D | 0.486 | 0.338 | **0.201** | −0.137 [−0.167, −0.107], 12/14 | ≤ 0.25 **met** |
| | Bite share 0-0.5 D | 0.382 | 0.193 | 0.120 | −0.074 [−0.109, −0.039], 12/14 | |
| | Bite share later-born, 0.75-1 D | — | 0.461 | 0.241 | −0.220, 10/11 | |
| 3 | Trace corr excess < 1 D | +0.150 | +0.106 | **+0.084** | −0.022 [−0.034, −0.013], 14/14 | ≤ Stage 1 met |
| 4 | Corr excess 0.5-1 D | +0.127 | +0.088 | +0.062 | −0.026, 14/14 | |
| 5 | Over-fill est/true > 1.3, pairs < 1 D | 0.059 | 0.067 | **0.075** (0.75-1 D 0.109) | +0.008 | ≤ 5 % **not met** |
| 5b | Over-fill next to undetected GT units, < 1 D | 0.090 | 0.086 | 0.098 | +0.012 [−0.012, +0.035], 8/10 | no worse than main: +0.008 [−0.016, +0.030] vs main, within noise |
| 6 | Matched / false cells per sim | 400.1 / 21.9 | 401.3 / 20.7 | 401.1 / 20.9 | −0.1 / +0.1 | met (vs main +1.0 / −1.0) |
| 7 | Merges / splits | 404 / 6.6 | 404 / 6.6 | 404 / 6.6 | 0 | met |
| 9 | Cluster stores, peak MB | — | 38-43 (s5) | 26.6 mean | | reported |
| 10 | Final cells matching 2+ GT units | 148.6 | 166.5 | 175.9 | +9.4 [5.6, 13.2], 13/14 | reported (support area 603 / 630 / 670 px) |
| 11 | Footprint r, isolated | 0.9922 | 0.9922 | 0.9922 | −0.0000 [−0.0010, +0.0011], 7/14 | no regression met |
| 12 | Trace r, isolated | 0.9818 | 0.9810 | 0.9811 | +0.0001 [−0.0039, +0.0036]; vs main −0.0007 [−0.0043, +0.0031] | no regression met |
| 13 | Footprint r, all | 0.9879 | 0.9899 | **0.9920** | +0.0021 [0.0017, 0.0026], 14/14 | |
| 13 | Footprint r, close pairs (< 1 D) | 0.9843 | 0.9879 | **0.9917** | +0.0038 [0.0030, 0.0045], 14/14 | |
| 13 | Footprint r < 0.9 share, all / close | 0.056 / 0.071 | 0.049 / 0.060 | 0.043 / 0.050 | −0.007 / −0.011 | |
| 13 | Trace r, all / close | 0.9676 / 0.9602 | 0.9704 / 0.9651 | 0.9717 / 0.9677 | +0.0013 / +0.0025 (14/14) | |

Flag off: `footprints.bin`, `footprints_pass1.bin` and `final.tsv` byte-identical to main on static s5 and motion s5.

## Discover only (`--passes 1 --joint-update all --joint-sign all`, quick tier, 5 sims)

`~/Projects/cala-data/demix-suite/quick-pass1-discover/report-stage2-vs-main.md`.

| metric | main Discover | Stage 1 Discover | Stage 2 Discover |
| ------ | ------------- | ---------------- | ---------------- |
| Footprint r, all / isolated / close | 0.9813 / 0.9881 / 0.9761 | 0.9854 / 0.9883 / 0.9836 | 0.9864 / 0.9881 / 0.9853 |
| Trace r, all / close | 0.9696 / 0.9617 | 0.9732 / 0.9674 | 0.9731 / 0.9670 |
| Corr excess < 1 D | +0.147 | +0.112 | +0.104 |
| Bite share 0.5-0.75 / 0.75-1 D | 0.479 / 0.669 | 0.314 / 0.507 | 0.297 / 0.437 |
| Over-fill next to undetected, < 1 D | 0.056 | 0.058 | 0.080 |
| Matched / false per sim | 346.8 / 15.0 | 338.4 / 15.2 | 337.8 / 14.6 |

Stage 2 vs main in Discover: better on every accuracy row (5/5 seeds) except isolated cells (unchanged), but
**−9.0 matched cells per sim [−18.4, +0.4], 4/5 seeds** (Stage 1's Discover arm had the same, −8.4). In Discover
the stores still restart on every library change (90 builds, 6519 store instances, only 730 replays on static s5),
so the replay runs on short histories; membership re-expression needs leftover-light directions (next step).
