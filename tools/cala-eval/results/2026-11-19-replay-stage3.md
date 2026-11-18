# Cluster replay, Stage 3: leftover light and stores that survive births (flag off by default)

19 Nov 2026. Branch `feat/cala-replay-stage3`, stacked on `feat/cala-replay-stage2` (#424). Design:
`~/Projects/cala-data/demix-bench/design_discover_lookback.md` §3.1 (leftover-light directions, provisional
component) and §3.2 (no restart on births); `design_joint_update.md` ("Stage 3 results" summarises this file).

## Pre-analysis of Stage 2's over-fill (existing trees, no new runs)

`full-signall/off` (main) and `full-stage2/stage2`, pairs < 1 D with a matched GT neighbour j (the row behind
the 0.059 → 0.075 figure), est/true of i's footprint at j's centre (both peak-normalised):

| split | main | Stage 2 |
| ----- | ---- | ------- |
| over-fill share (ratio > 1.3), all | 0.050 | 0.075 |
| ... and absolute excess est − true > 0.05 of peak | 0.044 | 0.049 |
| ... and absolute excess > 0.10 of peak | 0.028 | 0.027 |
| ... with true at c_j < 0.10 of peak (tail pixels) | 0.011 | 0.033 |
| static + pairs, 0.75-1 D, j in i's final cluster | 0.058 (n 1120) | 0.113 (n 1152) |
| static + pairs, 0.75-1 D, j outside i's cluster | 0.000 (n 152) | 0.066 (n 122) |
| over-filled pairs 0.75-1 D: j's footprint r / reverse bite share / median true at c_j | 0.982 / 0.78 / 0.130 | 0.993 / 0.26 / 0.086 |

Reading: Stage 2's extra over-fill is toward *detected* neighbours in the same cluster, at pixels where the true
footprint is under 10 % of its peak, and the neighbour's own footprint is good. It is mostly a small absolute
overshoot of a healed tail (median excess 0.07 of peak), not an absorbed cell; the absolute-excess rows are flat.
The leftover-light guard targets absorption of light *no member explains* (undetected or not-yet-born neighbours,
and out-of-cluster light), so it is not expected to move the ratio row much in Refine. Both rows are reported.

## Go / no-go, written down before any Stage 3 result

Arms. main (flag off); Stage 2 = `--joint-update refine --joint-sign all` (`full-stage2`); Stage 3 = Stage 2 +
`--joint-leftover m --joint-rebase` (m = 1 unless the quick tier says 2). Refine is judged in two arms:
`--joint-update refine` (replay starts on main's Discover library, so the guard starts late) and, reported,
`--joint-update all` with 2 passes (guard present from the start).

Refine (full tier, 14 sims, `--passes 2 --later-passes refine`):

| # | metric | target |
| - | ------ | ------ |
| 1 | Over-fill share est/true > 1.3, pairs < 1 D (detected neighbour) | ≤ 5 % (Stage 2 0.075, main 0.050); reported also with absolute excess > 0.05 of peak |
| 2 | Over-fill next to undetected GT units, < 1 D | ≤ main (0.090) |
| 3 | Footprint r all / close pairs | within CI of Stage 2 (0.9920 / 0.9917) or better |
| 4 | Trace corr excess < 1 D | within CI of Stage 2 (+0.084) or better |
| 5 | Bite share 0.5-0.75 / 0.75-1 D | within CI of Stage 2 (0.123 / 0.201) or better; split by birth order (earlier / later-born) |
| 6 | Isolated cells: footprint r, trace r | no regression vs main (paired change ≥ −0.005, CI upper end ≥ 0) |
| 7 | Matched / false / merges | within noise of Stage 2 and main |
| 8 | Cells matching 2+ GT units | reported, split into absorption (est/true > 1.3 at one of its GT units) and light regained (≤ 1.3) |

Discover only (`--passes 1 --joint-update all --joint-sign all`; quick tier to iterate, then full tier):

| # | metric | target |
| - | ------ | ------ |
| 9 | Matched cells per sim | ≥ main − 1 % (Stage 2: −9.0 / sim, quick tier) |
| 10 | False cells per sim | within noise of main |
| 11 | Accuracy rows (footprint r all/close, corr excess, bite share) | at least Stage 2's Discover-only readout |
| 12 | Store history | report: builds, fresh stores, rebases (history kept / dropped), restarts, replays |

Reported, not gated: share of main's Discover → +1 Refine gain reached (`demix_stages.py`, static s5 + pairs s5);
slow-loop cost from solo runs (observe + step ms/frame, static s5 and motion s5): no more than +5 % over Stage 2.

Principles: no size caps, no sparsity penalties; the provisional component is never published, never seen by the
fast loop, and is fitted under the same rules as a member (non-negative trace and footprint); same frames and
weights for every member whatever its age. Flag off (`--joint-update off`): byte-identical to main.
