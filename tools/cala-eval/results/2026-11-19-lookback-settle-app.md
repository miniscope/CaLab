# Look-back settle in the app: is the drain still needed?

19 Nov 2026. Branch `feat/cala-lookback-settle-app`. Context: `2026-11-19-lookback-settle.md` and
`2026-11-19-lookback-settle2.md`. The app gets the end-of-Discover settle (one pass through the ordinary `observe`,
16 frames per request). This file answers one question before the app keeps or drops the drain that runs before it.

## Question

Once the settle follows, does the drain (need-driven look-back after the last frame, up to 4800 steps, then 256
steps of visits on every tile) still add anything?

## Arms (written before the runs)

Quick tier (static s5-s7, pairs s5-s6), one Discover per sim (`--branch-after discover`), binary `qc_eval-lbsa-a`
(this branch: `--settle-frames` no longer requires `--lookback-drain`). Common: the suite's flags with
`--passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6`.

| arm       | tail                                                              |
| --------- | ----------------------------------------------------------------- |
| `SETTLE`  | `--lookback-drain 4800 --settle-frames 9600 --settle-batch 16`    |
| `ND+S`    | `--lookback-drain 0 --settle-frames 9600 --settle-batch 16`       |

## Targets (written before the runs)

`ND+S` minus `SETTLE`, paired over the 5 sims, 95 % CI. The drain is dropped from the app if all hold:

- footprint r, all cells: difference >= -0.0005
- footprint r, close pairs: >= -0.0010
- footprint r, born in second half: >= -0.005
- bitten footprints 0.75-1 D (share): <= +0.03
- false cells per sim: <= +2; matched cells per sim: >= -2

If any misses with a CI that excludes 0, the drain stays (and is made faster in the app). If one misses with a CI that
includes 0, it is reported as "between the lines" and the app keeps the drain unless the cost is large.

## Results

(filled in after the runs)
