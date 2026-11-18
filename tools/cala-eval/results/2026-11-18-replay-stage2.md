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
