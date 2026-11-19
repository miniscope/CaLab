# Concurrent Refine: look-back cursor inside Discover (prototype)

Targets written 18 Nov 2026 before any result (commit order shows it). Results below the targets.

## Question

Can a look-back cursor that runs during Discover, re-reading frames already seen from the saved
recording and feeding them through the existing Refine machinery (per-cell running statistics, the
cluster stores, refine visits) with the *current* footprints, replace the separate Refine pass?

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

## Results

(pending)
