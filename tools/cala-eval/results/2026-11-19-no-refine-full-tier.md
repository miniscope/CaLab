# Discover without Refine, full tier (19 Nov 2026)

Targets written 19 Nov 2026 before any run (commit order shows it). Results go below them.

## Question

Does the combined "Discover without Refine" configuration (look-back inside Discover from #427, the cluster replay,
and the merge rule from #429) match main Discover + 1 Refine on the full demix suite, at less compute?

## Arms (one binary, main f14efd8c, full tier: static s5-s9, motion s5-s9, pairs s5-s8)

- `DR-main`: main default, Discover + 1 Refine (`--passes 2 --later-passes refine`, the suite default).
- `COMBO`: `--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --merge-guard-sep 0.6`
  (no Refine pass).

## Targets (COMBO vs DR-main; paired suite rules, CIs from the suite)

Evaluated for all sims pooled and for the motion sims alone.

1. Footprint r with GT, median, in every footprint group (all matched cells, isolated, close-pair): within 0.003 of
   `DR-main` (COMBO minus DR-main >= -0.003).
2. Share of cells with footprint r < 0.9: within noise of `DR-main` (CI of the difference includes 0, or better).
3. Crosstalk (trace corr excess < 1 D, the headline) and bites (bite share ratio < 0.5, all bins): better than
   `DR-main` (CI of the difference favours COMBO).
4. Matched cells: within 1 % of `DR-main`.
5. False cells: within noise of `DR-main`.
6. Compute: lower total compute than `DR-main` (pass-loop wall summed over sims, including the look-back's own wall).

Also reported: birth-time rows (first half, second half, last 20 %), whether the look-back settles (cells still in
need at the end of Discover and after the drain, `lookback.tsv`), and the fast-loop per-frame cost.
