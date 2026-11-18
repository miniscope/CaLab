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

## What was built (flags, all off by default)

- `--joint-leftover m` (`SlowLoopConfig::joint_leftover`, m ≤ 2): each store's basis is `[U | L]`; `L` = the
  strongest residual patterns outside the members' span, tracked by a streaming power iteration
  (`Σ w r̃ (L_jᵀ r̃)`, centred, projected off `U`), refreshed every 256 pushes and at each replay. Stored frames keep
  K + m coordinates (§3.1a).
- Provisional components (on with `m > 0`, off with `--joint-no-provisional`): in each replay the leftover
  directions (rectified) are fitted as extra components, non-negative trace and footprint, covering every store
  pixel, carried between replays, re-seeded after a member-set change; never published (§3.1b).
- `--joint-rebase`: on a member-set change the store with the most members in common is re-expressed
  (`ClusterStore::rebase`): kept members keep their sums; an established cell joining had its light subtracted,
  so zero coordinates; a newborn's sums start from its least-squares traces in the stored frames ("takes over
  the leftover direction"), and its pre-birth frames are kept only when ≥ half its light lies in the stored span,
  else the history is dropped for the whole cluster; leftover directions after a change = top stored energy
  outside the new members' span (a departed member's light becomes leftover light).
- Counters in `ReplayStats`: fresh / rebased / rebased_birth / dropped / unions / set_restarts.
- Metrics: over-fill toward a matched neighbour (report filter true at c_j > 0.1) per bin and with an absolute
  excess > 0.05 of peak; 2+ GT cells split into absorption / light regained (`multi_gt_absorb`, `multi_gt_regained`).

Toys (`cluster.rs`): `an_undetected_neighbour_is_not_absorbed` (j-i-k at 1 D, k undetected, 3 seeds: without
leftover light i at k's centre > 1.3 × truth, with one provisional component < 1.3); `a_store_survives_a_birth`
(history kept, newborn starts filling from the first replays; in this toy a restarted store catches up after
~1500 frames). A carried provisional is needed: re-seeding it every replay from the direction lets i absorb k
(15.9 × truth).

Checks: `--joint-leftover 0` without `--joint-rebase` is byte-identical to Stage 2 (`footprints.bin`, `final.tsv`,
static s5 + pairs s5, `st3-smoke-eq`); flag off is unchanged code (the Stage 2 identity with main holds). fmt,
clippy (jsbindings, pybindings, jsbindings+diagnostics), cala cluster tests, `tools/cala-eval` unittests pass.

## Over-fill with the report's own filter (true at c_j > 0.1)

The 0.075 figure in the Stage 2 file was computed without the report's `true_at_cj > 0.1` filter. With it, full
tier, pairs < 1 D, matched neighbour: main 0.046, Stage 2 0.050 (+0.004 [−0.005, +0.013], within noise); with an
absolute excess > 0.05 of peak as well: 0.043 / 0.045. So Stage 2 already meets ≤ 5 % on the filtered row; the
unfiltered excess is tail overshoot (pre-analysis above).

## Refine, smoke tier (static s5 + pairs s5; not a significance test)

`demix-suite/st3-smoke-refine`, Stage 2 vs Stage 3 (`--joint-leftover 1 --joint-rebase`, provisional on):
footprint r all 0.9926 → 0.9920, close 0.9927 → 0.9915 (2/2 seeds down), corr excess +0.078 → +0.090, bite
0.75-1 D 0.233 → 0.277, over-fill at undetected neighbours 0.093 → 0.067, matched / false −0.5 / +0.5 per sim.
Slow observe on static s5 pass 2: 4.5 ms/frame (Stage 2 about 3.2 in the solo table; suite timing, indicative).
Direction: the provisional component costs some of Stage 2's healing in Refine. Full tier not run (see verdict).

## Discover only, quick tier (5 sims, `--passes 1 --joint-update all --joint-sign all`)

`demix-suite/st3-quick-discover` (arms `st3prov` = leftover 1 + rebase + provisional, `st3store` = same with
`--joint-no-provisional`), each against `quick-pass1-discover/main-pass1`:

| metric | main | Stage 2 | Stage 3 (provisional) | Stage 3 (stored only) |
| ------ | ---- | ------- | --------------------- | --------------------- |
| Footprint r all / close | 0.9813 / 0.9761 | 0.9864 / 0.9853 | 0.9862 / 0.9851 | **0.9870 / 0.9864** |
| Corr excess < 1 D | +0.147 | +0.104 | +0.109 | **+0.095** |
| Bite share 0.5-0.75 / 0.75-1 D | 0.479 / 0.669 | 0.297 / 0.437 | 0.311 / 0.466 | **0.256 / 0.432** |
| Over-fill, matched neighbour < 1 D | 0.059 | 0.049 | **0.027** (vs main −0.032 [−0.048, −0.016], 5/5) | 0.035 (5/5) |
| Over-fill, undetected neighbour < 1 D | 0.056 | 0.080 | 0.079 | 0.089 |
| Matched / false per sim | 346.8 / 15.0 | 337.8 / 14.6 | 339.2 / 16.8 (−7.6 [−15.2, 0.0]) | 336.0 / 17.6 (−10.8 [−22.0, +0.4]) |

Store history on static s5 (Discover): 85 builds; 140 fresh stores (groups made only of previously lone cells),
103 rebased (only 6 with a newborn member), 35 dropped (a newborn's light outside the stored span), 20 unions,
0 restarts of a moving store; 710 replays (Stage 2: 730).

Reading:
- Rebase works mechanically but rarely meets a birth: most Discover births join a **lone** cell, which has no
  store, so the new cluster starts fresh. Re-expression does not lengthen the replayed history much, and the
  replay count is unchanged.
- The matched-cell loss is **not** caused by store restarts: it persists (−7.6 / −10.8, Stage 2 −9.0).
- Stored-only leftover directions give the best Discover accuracy (footprint r close 0.9864, corr excess +0.095,
  bite 0.5-0.75 D 0.256) but slightly more false cells. The provisional component halves over-fill toward matched
  neighbours (0.059 → 0.027) but gives back a little healing and does not move the undetected-neighbour row.

## Verdict (provisional; full tier not run)

Not met: Discover matched cells within 1 % of main (−2.2 % / −3.1 %); undetected-neighbour over-fill ≤ main.
Met in the quick tier: over-fill toward matched neighbours (0.027 with the provisional component). Refine smoke
points the wrong way on the accuracy rows with the provisional component. Stage 3 does not clearly improve on
Stage 2, so no PR: the branch is pushed with the code behind flags. Next steps in `HANDOFF.md`.
